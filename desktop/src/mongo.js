// Runs a private MongoDB instance for the desktop app: a single-node replica set
// (the server needs transactions) bound to 127.0.0.1, with its data under the user's AppData.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');

const REPL_SET = 'rs0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tail(file, lines = 15) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function startMongo({ mongodPath, dbPath, logPath, port }) {
  fs.mkdirSync(dbPath, { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const args = [
    '--dbpath', dbPath,
    '--port', String(port),
    '--bind_ip', '127.0.0.1',
    '--replSet', REPL_SET,
    '--logpath', logPath,
    '--logappend',
    // Small inventory database: keep MongoDB's memory use modest on a shared desktop PC.
    '--wiredTigerCacheSizeGB', '0.5',
  ];
  const proc = spawn(mongodPath, args, { windowsHide: true, stdio: 'ignore' });

  let exited = null;
  const exitPromise = new Promise((resolve) => {
    proc.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
    proc.once('error', (err) => {
      exited = { error: err };
      resolve(exited);
    });
  });

  const fail = (why) => {
    const log = tail(logPath);
    return new Error(`${why}${log ? `\n\nLast lines of ${logPath}:\n${log}` : ''}`);
  };

  // Wait until mongod accepts connections.
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
    serverSelectionTimeoutMS: 1000,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) {
      throw fail(
        exited.error
          ? `Could not start MongoDB (${mongodPath}): ${exited.error.message}`
          : `MongoDB stopped during start-up (exit code ${exited.code ?? exited.signal}).`,
      );
    }
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw fail('MongoDB did not start within 60 seconds.');
      }
      await sleep(500);
    }
  }

  // Initialise the replica set on first run; if the port changed since last time,
  // point the set's only member at the new address.
  const admin = client.db('admin');
  const host = `127.0.0.1:${port}`;
  try {
    const { config } = await admin.command({ replSetGetConfig: 1 });
    if (config.members.length !== 1 || config.members[0].host !== host) {
      config.members = [{ ...config.members[0], host }];
      config.version += 1;
      await admin.command({ replSetReconfig: config, force: true });
    }
  } catch (err) {
    if (err.codeName !== 'NotYetInitialized') throw err;
    await admin.command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host }] } });
  }

  // Wait to become primary (writable).
  for (const until = Date.now() + 60_000; ; ) {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    if (Date.now() > until) throw fail('MongoDB did not become ready (replica set primary) within 60 seconds.');
    await sleep(300);
  }

  return {
    uri: `mongodb://127.0.0.1:${port}/mes_store?replicaSet=${REPL_SET}`,

    async countActiveAdmins() {
      return client.db('mes_store').collection('users').countDocuments({ role: 'admin', active: true });
    },

    /** Clean shutdown (flushes data); falls back to killing the process. */
    async stop() {
      if (exited) return;
      try {
        await admin.command({ shutdown: 1, force: true, timeoutSecs: 5 });
      } catch {
        // The connection drops as the server shuts down; that is expected.
      }
      await client.close(true).catch(() => {});
      const timedOut = await Promise.race([exitPromise.then(() => false), sleep(20_000).then(() => true)]);
      if (timedOut) proc.kill();
    },
  };
}

module.exports = { startMongo };
