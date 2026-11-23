// Runs scripts/create-admin.js as a separate process, the way the desktop app does, and
// checks that it exits by itself. The desktop app runs it in an Electron utility process, whose
// message channel keeps the process alive until it calls process.exit(); a script that relied on
// the event loop draining hung there and left the first-run setup screen stuck on "Creating…".
// To reproduce that here, the child gets an IPC channel with a listener attached (KEEP_ALIVE).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_WITHIN_MS = 15_000;
const KEEP_ALIVE = `data:text/javascript,${encodeURIComponent("process.on('message', () => {});")}`;

let replSet;
let uri;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  uri = replSet.getUri('mes_create_admin_test');
});

afterAll(async () => {
  await replSet?.stop();
});

function runCreateAdmin(extraEnv) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', KEEP_ALIVE, 'scripts/create-admin.js'], {
      cwd: serverDir,
      // stdin closed: if the script ever waited for a prompt it would fail instead of hanging.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
        MONGODB_URI: uri,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`create-admin.js did not exit within ${EXIT_WITHIN_MS} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, EXIT_WITHIN_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

async function findUser(username) {
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    return await conn.db.collection('users').findOne({ username });
  } finally {
    await conn.close();
  }
}

describe('scripts/create-admin.js', () => {
  it('creates the admin and exits with code 0 on its own', async () => {
    const res = await runCreateAdmin({ ADMIN_USERNAME: 'Storeadmin', ADMIN_NAME: 'Store Admin', ADMIN_PASSWORD: 'Passw0rd123' });
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Created admin user "storeadmin"');

    const user = await findUser('storeadmin');
    expect(user).toMatchObject({ username: 'storeadmin', name: 'Store Admin', role: 'admin', active: true });
    expect(user.passwordHash).not.toContain('Passw0rd123');
  });

  it('exits with code 1 and creates nothing when the password is too weak', async () => {
    const res = await runCreateAdmin({ ADMIN_USERNAME: 'weakadmin', ADMIN_NAME: 'Weak', ADMIN_PASSWORD: 'short' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Error: Password must be at least 8 characters');
    expect(await findUser('weakadmin')).toBeNull();
  });
});
