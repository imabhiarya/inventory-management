// Create (or reset the password of) an admin user.
// Usage:  npm run create-admin
//         ADMIN_USERNAME=admin ADMIN_NAME="Store Officer" ADMIN_PASSWORD=... npm run create-admin
import readline from 'node:readline';
import env from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db.js';
import User from '../src/models/User.js';
import { passwordSchema } from '../src/validation/password.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const username = (process.env.ADMIN_USERNAME || (await ask('Admin username: '))).toLowerCase();
  const name = process.env.ADMIN_NAME || (await ask('Full name: ')) || username;
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (min 8 chars, letters + numbers): ', { hidden: true });
    const confirm = await ask('Confirm password: ', { hidden: true });
    if (password !== confirm) throw new Error('Passwords do not match');
  }
  const check = passwordSchema.safeParse(password);
  if (!check.success) throw new Error(check.error.issues[0].message);
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Username: 3–32 characters, letters, numbers, . _ -');

  await connectDb(env.MONGODB_URI);
  const passwordHash = await User.hashPassword(password);
  const existing = await User.findOne({ username });
  if (existing) {
    existing.set({ passwordHash, role: 'admin', active: true, tokenVersion: existing.tokenVersion + 1 });
    await existing.save();
    console.log(`Updated existing user "${username}" as admin and reset the password.`);
  } else {
    await User.create({ username, name, role: 'admin', passwordHash });
    console.log(`Created admin user "${username}".`);
  }
  await disconnectDb();
}

main().then(
  // Exit explicitly: open handles (timers, the IPC channel of an Electron utility
  // process) can otherwise keep the process alive after the work is done.
  () => process.exit(process.exitCode ?? 0),
  async (err) => {
    console.error(`Error: ${err.message}`);
    await disconnectDb().catch(() => {});
    process.exit(1);
  },
);
