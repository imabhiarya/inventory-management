// Builds the React UI and stages a production copy of the API server under desktop/build/,
// which electron-builder then ships as extraResources.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktopDir, '..');
const out = path.join(desktopDir, 'build');

const run = (cmd, cwd) => {
  console.log(`> ${cmd}  (in ${path.relative(root, cwd) || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. React client
if (!fs.existsSync(path.join(root, 'client/node_modules'))) run('npm ci', path.join(root, 'client'));
run('npm run build', path.join(root, 'client'));
fs.cpSync(path.join(root, 'client/dist'), path.join(out, 'client'), { recursive: true });

// 2. Express server: source + production dependencies only (all pure JavaScript, so a
//    copy installed on macOS/Linux works unchanged on Windows).
const serverOut = path.join(out, 'server');
for (const entry of ['src', 'scripts', 'package.json', 'package-lock.json']) {
  fs.cpSync(path.join(root, 'server', entry), path.join(serverOut, entry), { recursive: true });
}
run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', serverOut);

console.log(`\nStaged client and server in ${path.relative(root, out)}/`);
