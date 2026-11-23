// Restore a backup file (made with Backup & Restore → Download Backup) into this database.
// The desktop app runs this from its first-run screen so a new PC can take over from a failed one.
// Usage:  BACKUP_FILE=/path/to/mes-store-backup-….json npm --prefix server run restore-backup
import fs from 'node:fs/promises';
import env from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { backupSchema, restoreBackup } from '../src/services/backup.js';

async function main() {
  const file = process.env.BACKUP_FILE || process.argv[2];
  if (!file) throw new Error('Give the backup file: BACKUP_FILE=… or as the first argument');
  let json;
  try {
    json = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? 'The file is not a valid backup (not JSON).' : `Could not read the file: ${err.message}`);
  }
  const parsed = backupSchema.safeParse(json);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  await connectDb(env.MONGODB_URI);
  const { counts } = await restoreBackup(parsed.data, { user: { username: 'backup restore (setup)' }, ip: 'local' }, { requireUsers: true });
  console.log(`Restored: ${JSON.stringify(counts)}`);
  await disconnectDb();
}

main().then(
  // Exit explicitly: the IPC channel of an Electron utility process keeps it alive otherwise.
  () => process.exit(process.exitCode ?? 0),
  async (err) => {
    console.error(`Error: ${err.message}`);
    await disconnectDb().catch(() => {});
    process.exit(1);
  },
);
