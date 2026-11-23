// Runs scripts/restore-backup.js as a separate process against an empty database, the way the
// desktop app's first-run screen does on a new PC that takes over from a failed one.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_ALIVE = `data:text/javascript,${encodeURIComponent("process.on('message', () => {});")}`;

let replSet;
let tmp;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mes-restore-'));
});

afterAll(async () => {
  await replSet?.stop();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

function runRestore(uri, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', KEEP_ALIVE, 'scripts/restore-backup.js'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'silent', JWT_SECRET: 'test-secret-test-secret-test-secret-1234', MONGODB_URI: uri, BACKUP_FILE: file },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`restore-backup.js did not exit\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function withDb(uri, fn) {
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    return await fn(conn.db);
  } finally {
    await conn.close();
  }
}

const id = () => new mongoose.Types.ObjectId().toHexString();

async function writeBackup(name, { users, files = [] }) {
  const itemId = id();
  const backup = {
    format: 'mes-store-backup',
    version: 2,
    createdAt: new Date().toISOString(),
    createdBy: 'oldadmin',
    data: {
      users,
      items: [{ _id: itemId, code: 'ST-0001', name: 'A4 Paper', ledger: 'STATIONARY', uom: 'Ream', currentStock: 12 }],
    },
    files,
  };
  const file = path.join(tmp, name);
  await fs.writeFile(file, JSON.stringify(backup));
  return file;
}

describe('scripts/restore-backup.js (new PC from an old PC backup)', () => {
  it('restores data, attachments and the old sign-in accounts into an empty database', async () => {
    const uri = replSet.getUri('mes_restore_ok');
    const fileId = id();
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    const file = await writeBackup('ok.json', {
      users: [{ _id: id(), username: 'oldadmin', name: 'Old Admin', role: 'admin', active: true, passwordHash: await bcrypt.hash('Passw0rd123', 4) }],
      files: [{ _id: fileId, filename: 'para.pdf', metadata: { type: 'application/pdf' }, data: pdf.toString('base64') }],
    });

    const res = await runRestore(uri, file);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);

    await withDb(uri, async (db) => {
      const admin = await db.collection('users').findOne({ username: 'oldadmin' });
      expect(admin).toMatchObject({ role: 'admin', active: true });
      expect(await bcrypt.compare('Passw0rd123', admin.passwordHash)).toBe(true);
      expect(await db.collection('items').findOne({ code: 'ST-0001' })).toMatchObject({ currentStock: 12 });
      const chunks = [];
      const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'auditFiles' });
      for await (const c of bucket.openDownloadStream(new mongoose.Types.ObjectId(fileId))) chunks.push(c);
      expect(Buffer.concat(chunks).equals(pdf)).toBe(true);
    });
  });

  it('refuses a backup without an administrator (nobody could sign in) and changes nothing', async () => {
    const uri = replSet.getUri('mes_restore_noadmin');
    const file = await writeBackup('noadmin.json', { users: [] });
    const res = await runRestore(uri, file);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('no administrator');
    await withDb(uri, async (db) => expect(await db.collection('items').countDocuments()).toBe(0));
  });

  it('refuses a file that is not a backup', async () => {
    const file = path.join(tmp, 'junk.json');
    await fs.writeFile(file, '{"hello":1}');
    const res = await runRestore(replSet.getUri('mes_restore_junk'), file);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('not an MES Store backup');
  });
});
