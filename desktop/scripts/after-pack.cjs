// electron-builder never copies node_modules folders through extraResources, so copy the
// API server's production dependencies (staged by prepare.mjs) into the packed app here.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, '..', 'build', 'server', 'node_modules');
  const to = path.join(context.appOutDir, 'resources', 'server', 'node_modules');
  if (!fs.existsSync(from)) throw new Error('build/server/node_modules is missing: run "npm run prepare:resources" first');
  fs.cpSync(from, to, { recursive: true });
};
