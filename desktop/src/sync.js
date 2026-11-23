// One-way mirror of the local database to an online MongoDB (e.g. MongoDB Atlas).
//
// The app always reads and writes the local database, so it works the same with or without
// internet. This mirror follows the local change stream and applies each change to the online
// copy by _id (replace-with-latest / delete), so replaying a change twice can never create a
// duplicate. The position in the change stream (resume token) is saved after every applied
// batch: after an outage the sync resumes exactly where it stopped, and if that position is
// no longer available it re-copies everything and removes anything the laptop no longer has.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { MongoClient, BSON } = require('mongodb');
const { resolveSrvUri } = require('./srv');

const BATCH = 500;
const META = '_sync_meta'; // marker collection in the online database
const NETWORK_ERRORS = /DnsLookupError|MongoNetwork|MongoServerSelection|MongoTopologyClosed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/;

class FullResyncNeeded extends Error {}

const idKey = (id) => BSON.EJSON.stringify(id, { relaxed: false });
const isNetworkError = (err) => NETWORK_ERRORS.test(`${err?.name} ${err?.message} ${err?.cause?.message || ''}`);

/** Connects and checks that `dbName` is empty or already mirrors this installation. */
async function checkTarget({ remoteUri, dbName, installationId }) {
  // Resolve mongodb+srv:// ourselves, with fallbacks for DNS servers that can't answer SRV lookups.
  const client = new MongoClient(await resolveSrvUri(remoteUri), {
    serverSelectionTimeoutMS: 10_000,
    appName: 'store-inventory-sync',
  });
  try {
    await client.connect();
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    const marker = await db.collection(META).findOne({ _id: 'source' });
    if (marker && marker.installationId !== installationId) {
      throw new Error(
        `Database "${dbName}" is already the online copy of another computer (${marker.computer || 'unknown'}). ` +
          'Use a different database name.',
      );
    }
    if (!marker) {
      const others = (await db.listCollections({}, { nameOnly: true }).toArray()).filter((c) => !c.name.startsWith('system.'));
      if (others.length) {
        throw new Error(`Database "${dbName}" already contains data. Choose an empty (new) database name so nothing is overwritten.`);
      }
    }
    return { client, db, fresh: !marker };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

class MirrorSync extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.localUri   local replica-set URI (database name in the path)
   * @param {string} o.remoteUri  online MongoDB URI
   * @param {string} o.dbName     online database name
   * @param {string} o.statePath  JSON file for the resume token
   * @param {string} o.installationId
   * @param {string} [o.computer] label stored in the online marker
   */
  constructor(o) {
    super();
    this.o = o;
    this.running = false;
    this.status = { state: 'connecting', lastSyncedAt: this._readState().lastSyncedAt || null, error: null };
    this._wake = null;
    this._stream = null;
    this._remote = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.local = new MongoClient(this.o.localUri, { serverSelectionTimeoutMS: 10_000 });
    this._loopDone = this._loop();
  }

  async stop() {
    this.running = false;
    this._wake?.();
    await this._stream?.close().catch(() => {});
    await this._remote?.close().catch(() => {});
    await this._loopDone?.catch(() => {});
    await this.local?.close().catch(() => {});
  }

  /** Retry straight away instead of waiting for the next back-off attempt. */
  syncNow() {
    this._wake?.();
  }

  // ------------------------------------------------------------ internals

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  _readState() {
    try {
      return JSON.parse(fs.readFileSync(this.o.statePath, 'utf8'));
    } catch {
      return {};
    }
  }

  _writeState(patch) {
    const next = { ...this._readState(), ...patch };
    fs.writeFileSync(`${this.o.statePath}.tmp`, JSON.stringify(next));
    fs.renameSync(`${this.o.statePath}.tmp`, this.o.statePath);
  }

  _targetKey() {
    // A different online database (or server) means starting over with a full copy.
    const host = this.o.remoteUri
      .replace(/^mongodb(\+srv)?:\/\//, '')
      .replace(/^[^@/]*@/, '') // credentials
      .replace(/[/?].*$/, ''); // path and options
    return `${host}/${this.o.dbName}`;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this._wake = done;
    }).finally(() => {
      this._wake = null;
    });
  }

  async _loop() {
    let delay = 5_000;
    while (this.running) {
      try {
        await this._session();
        delay = 5_000;
      } catch (err) {
        if (!this.running) break;
        if (err instanceof FullResyncNeeded) {
          this._writeState({ resumeToken: null });
          continue;
        }
        if (isNetworkError(err)) this._set({ state: 'offline', error: null });
        else this._set({ state: 'error', error: err.message });
        this.emit('log', err);
        await this._stream?.close().catch(() => {});
        await this._remote?.close().catch(() => {});
        this._stream = this._remote = null;
        await this._sleep(delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  async _session() {
    this._set({ state: 'connecting' });
    await this.local.connect();
    const localDb = this.local.db();

    const { client, db: remoteDb } = await checkTarget(this.o);
    this._remote = client;
    if (!this.running) return;

    const state = this._readState();
    let streamOpts = { fullDocument: 'updateLookup', maxAwaitTimeMS: 2000, batchSize: BATCH };

    if (state.resumeToken && state.target === this._targetKey()) {
      streamOpts.resumeAfter = state.resumeToken;
    } else {
      // First sync (or new target): note the local time, copy everything, then replay
      // whatever changed during the copy. Replays are idempotent, so overlap is harmless.
      const { operationTime } = await localDb.command({ ping: 1 });
      this._set({ state: 'uploading' });
      await remoteDb.collection(META).updateOne(
        { _id: 'source' },
        { $set: { installationId: this.o.installationId, computer: this.o.computer, startedAt: new Date() } },
        { upsert: true },
      );
      await this._fullCopy(localDb, remoteDb);
      streamOpts.startAtOperationTime = operationTime;
    }

    const stream = localDb.watch([], streamOpts);
    this._stream = stream;
    let token = streamOpts.resumeAfter || null;
    let lastPing = Date.now();

    while (this.running) {
      const batch = [];
      try {
        while (batch.length < BATCH) {
          const change = await stream.tryNext(); // null = caught up (waits up to maxAwaitTimeMS)
          if (!change) break;
          batch.push(change);
        }
      } catch (err) {
        // 286 = ChangeStreamHistoryLost, 260 = InvalidResumeToken, 280 = ChangeStreamFatalError
        if ([286, 260, 280].includes(err.code)) throw new FullResyncNeeded(err.message);
        throw err;
      }
      if (!this.running) break;

      if (batch.length) {
        this._set({ state: 'uploading' });
        await this._apply(remoteDb, batch);
      } else if (Date.now() - lastPing > 30_000) {
        // Idle: check the online copy is still reachable, so the status shown is honest.
        await remoteDb.command({ ping: 1 });
        lastPing = Date.now();
      }

      // Only after the batch is safely online: remember how far we got.
      if (stream.resumeToken && idKey(stream.resumeToken) !== idKey(token)) {
        token = stream.resumeToken;
        this._writeState({ resumeToken: token, target: this._targetKey() });
      }

      const caughtUp = batch.length < BATCH;
      const stale = Date.now() - new Date(this.status.lastSyncedAt || 0) > 60_000;
      if (caughtUp && (this.status.state !== 'synced' || batch.length || stale)) {
        const lastSyncedAt = new Date().toISOString();
        this._writeState({ lastSyncedAt });
        this._set({ state: 'synced', lastSyncedAt, error: null });
      }
    }
  }

  async _apply(remoteDb, changes) {
    const byColl = new Map();
    for (const c of changes) {
      if (['drop', 'rename', 'dropDatabase', 'invalidate'].includes(c.operationType)) {
        throw new FullResyncNeeded(`local ${c.operationType}`);
      }
      if (!c.ns?.coll || !c.documentKey) continue;
      const _id = c.documentKey._id;
      let op;
      if (c.operationType === 'delete' || !c.fullDocument) op = { deleteOne: { filter: { _id } } };
      else op = { replaceOne: { filter: { _id }, replacement: c.fullDocument, upsert: true } };
      if (!byColl.has(c.ns.coll)) byColl.set(c.ns.coll, []);
      byColl.get(c.ns.coll).push(op);
    }
    for (const [coll, ops] of byColl) {
      await remoteDb.collection(coll).bulkWrite(ops, { ordered: true });
    }
  }

  async _fullCopy(localDb, remoteDb) {
    const localColls = (await localDb.listCollections({ type: 'collection' }, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'));

    for (const name of localColls) {
      const ids = new Set();
      let ops = [];
      for await (const doc of localDb.collection(name).find({}, { batchSize: BATCH })) {
        if (!this.running) return;
        ids.add(idKey(doc._id));
        ops.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
        if (ops.length >= BATCH) {
          await remoteDb.collection(name).bulkWrite(ops, { ordered: false });
          ops = [];
        }
      }
      if (ops.length) await remoteDb.collection(name).bulkWrite(ops, { ordered: false });

      // Remove online documents the laptop no longer has.
      let stale = [];
      for await (const { _id } of remoteDb.collection(name).find({}, { projection: { _id: 1 }, batchSize: 5000 })) {
        if (!ids.has(idKey(_id))) stale.push(_id);
        if (stale.length >= BATCH) {
          await remoteDb.collection(name).deleteMany({ _id: { $in: stale } });
          stale = [];
        }
      }
      if (stale.length) await remoteDb.collection(name).deleteMany({ _id: { $in: stale } });
    }

    // Collections that exist online but not locally any more.
    const keep = new Set([...localColls, META]);
    for (const { name } of await remoteDb.listCollections({}, { nameOnly: true }).toArray()) {
      if (!keep.has(name) && !name.startsWith('system.')) await remoteDb.collection(name).drop().catch(() => {});
    }
  }
}

module.exports = { MirrorSync, checkTarget };
