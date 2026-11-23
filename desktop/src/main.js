// Electron main process: starts a private MongoDB, then the Express API (which also serves
// the built React UI) on 127.0.0.1, and shows it in a desktop window.
const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, utilityProcess } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startMongo } = require('./mongo');
const { MirrorSync, checkTarget } = require('./sync');

// Single source of truth: "productName" in desktop/package.json.
const APP_NAME = app.getName();
const PREFERRED_MONGO_PORT = 27217;
const PREFERRED_APP_PORT = 47815;
const isWin = process.platform === 'win32';
// Window icon (Windows also takes it from the .exe; this covers development runs).
const APP_ICON = path.join(__dirname, 'ui/logo.png');

// Development runs keep their data apart from an installed copy on the same machine.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), `${APP_NAME} (dev)`));
if (process.env.MES_STORE_DATA_DIR) app.setPath('userData', path.resolve(process.env.MES_STORE_DATA_DIR));

const repoRoot = path.resolve(__dirname, '../..');
const paths = {
  userData: app.getPath('userData'),
  db: path.join(app.getPath('userData'), 'db'),
  logs: path.join(app.getPath('userData'), 'logs'),
  config: path.join(app.getPath('userData'), 'config.json'),
  syncState: path.join(app.getPath('userData'), 'sync-state.json'),
  server: app.isPackaged ? path.join(process.resourcesPath, 'server') : path.join(repoRoot, 'server'),
  client: app.isPackaged ? path.join(process.resourcesPath, 'client') : path.join(repoRoot, 'client/dist'),
  mongod: resolveMongod(),
};

function resolveMongod() {
  const exe = isWin ? 'mongod.exe' : 'mongod';
  if (app.isPackaged) return path.join(process.resourcesPath, 'mongodb', exe);
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const vendored = path.join(__dirname, '..', 'vendor/mongodb', `${process.platform}-${process.arch}`, exe);
  return fs.existsSync(vendored) ? vendored : exe; // fall back to mongod on PATH
}

let mongo = null;
let server = null;
let mainWindow = null;
let splash = null;
let quitting = false;
let started = false;
let appUrl = null;
let config = null;
let sync = null;
let syncWindow = null;

// ---------------------------------------------------------------- helpers

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    /* first run */
  }
  if (!cfg.jwtSecret) cfg.jwtSecret = crypto.randomBytes(48).toString('hex');
  if (!cfg.installationId) cfg.installationId = crypto.randomUUID();
  return cfg;
}

function saveConfig(cfg) {
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** The preferred port if free (keeps the origin, and so the UI's saved preferences, stable), else any free port. */
async function pickPort(preferred) {
  if (preferred && (await portIsFree(preferred))) return preferred;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Rotate a log file at start-up once it passes 5 MB. */
function rotate(file) {
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`);
  } catch {
    /* no log yet */
  }
}

function serverEnv(cfg, extra = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(cfg.appPort),
    MONGODB_URI: mongo.uri,
    JWT_SECRET: cfg.jwtSecret,
    // Served over http://127.0.0.1, so the session cookie cannot be marked Secure.
    COOKIE_SECURE: 'false',
    SERVE_CLIENT: 'true',
    CLIENT_DIST: paths.client,
    LOG_LEVEL: 'info',
    ...extra,
  };
  delete env.TRUST_PROXY;
  delete env.CORS_ORIGIN;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function waitForHealth(port, proc, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let exited = false;
    proc.once('exit', (code) => {
      exited = true;
      reject(new Error(`The application server stopped during start-up (exit code ${code}).`));
    });
    const attempt = () => {
      if (exited) return;
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (exited) return;
      if (Date.now() > deadline) return reject(new Error('The application server did not respond within 60 seconds.'));
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

// ---------------------------------------------------------------- windows

function showSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 300,
    icon: APP_ICON,
    frame: false,
    resizable: false,
    show: false,
    center: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'ui/splash.html'));
  splash.once('ready-to-show', () => splash.show());
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

/** First run: no admin user exists yet, so ask for one before the login screen. */
function runFirstAdminSetup(cfg) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 600,
      resizable: false,
      title: `${APP_NAME} — first-time setup`,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'ui/setup-preload.js'),
        sandbox: true,
        contextIsolation: true,
      },
    });
    let done = false;

    const handler = async (_event, input) => {
      const username = String(input?.username || '').trim().toLowerCase();
      const name = String(input?.name || '').trim() || username;
      const password = String(input?.password || '');
      if (!username || !password) return { ok: false, error: 'Username and password are required.' };
      let result;
      try {
        result = await runScript('scripts/create-admin.js', serverEnv(cfg, {
          ADMIN_USERNAME: username,
          ADMIN_NAME: name,
          ADMIN_PASSWORD: password,
        }));
        // The database is the source of truth: if an active admin now exists, setup worked,
        // even if the script reported a failure or had to be stopped after a timeout.
        if ((await mongo.countActiveAdmins()) === 0) {
          const msg =
            (result.stderr.match(/Error: (.*)/) || [])[1] || result.error || 'Could not create the administrator.';
          return { ok: false, error: msg };
        }
      } catch (err) {
        return { ok: false, error: `Could not create the administrator: ${err.message}` };
      }
      done = true;
      setImmediate(() => win.destroy());
      return { ok: true };
    };
    ipcMain.handle('setup:create-admin', handler);

    win.on('closed', () => {
      ipcMain.removeHandler('setup:create-admin');
      resolve(done);
    });
    win.loadFile(path.join(__dirname, 'ui/setup.html'));
    win.once('ready-to-show', () => {
      closeSplash();
      win.show();
    });
  });
}

function createMainWindow() {
  const origin = new URL(appUrl).origin;
  const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false };

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: APP_NAME,
    icon: APP_ICON,
    show: false,
    autoHideMenuBar: true,
    webPreferences,
  });

  // Same-app links (e.g. audit PDFs) open in a new app window; anything else in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences } };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(origin)) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });
  });

  // The window title carries the online-sync status, so keep the page from replacing it.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    refreshSyncUi();
  });
  mainWindow.loadURL(appUrl);
  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Data Folder', click: () => shell.openPath(paths.userData) },
        { label: 'Open Logs Folder', click: () => shell.openPath(paths.logs) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Online Sync',
      submenu: [
        { label: 'Sync Settings…', click: openSyncSettings },
        { label: 'Sync Now', click: () => sync?.syncNow() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: APP_NAME,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail: `Data folder: ${paths.userData}\nElectron ${process.versions.electron}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- online sync

function encryptSecret(text) {
  if (safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(text).toString('base64') };
  return { plain: text }; // Windows always has DPAPI; this is only a fallback
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (stored.plain) return stored.plain;
  return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
}

function syncSettings() {
  return { enabled: false, dbName: 'store_inventory', ...(config?.sync || {}) };
}

function syncStatusText(st = sync?.status) {
  if (!sync || !st) return '';
  const at = st.lastSyncedAt ? new Date(st.lastSyncedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  switch (st.state) {
    case 'synced':
      return `Online copy up to date${at ? ` (${at})` : ''}`;
    case 'uploading':
      return 'Uploading changes to the online copy…';
    case 'connecting':
      return 'Connecting to the online copy…';
    case 'offline':
      return `Offline: entries are saved on this computer and upload automatically when the internet is back${at ? ` · last upload ${at}` : ''}`;
    case 'error':
      return `Online sync problem: ${st.error}`;
    default:
      return '';
  }
}

function refreshSyncUi() {
  const text = syncStatusText();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(text ? `${APP_NAME}  —  ${text}` : APP_NAME);
  if (syncWindow && !syncWindow.isDestroyed()) syncWindow.webContents.send('sync:status', { ...sync?.status, text });
}

async function restartSync() {
  if (sync) {
    const old = sync;
    sync = null;
    await old.stop().catch(() => {});
  }
  const s = syncSettings();
  if (!s.enabled || !s.uri || !mongo) {
    refreshSyncUi();
    return;
  }
  sync = new MirrorSync({
    localUri: mongo.uri,
    remoteUri: decryptSecret(s.uri),
    dbName: s.dbName,
    statePath: paths.syncState,
    installationId: config.installationId,
    computer: os.hostname(),
  });
  const logFile = path.join(paths.logs, 'sync.log');
  sync.on('status', refreshSyncUi);
  sync.on('log', (err) => fs.appendFile(logFile, `${new Date().toISOString()} ${err.stack || err}\n`, () => {}));
  sync.start();
  refreshSyncUi();
}

function openSyncSettings() {
  if (syncWindow && !syncWindow.isDestroyed()) return syncWindow.focus();
  syncWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    parent: mainWindow || undefined,
    title: `${APP_NAME} — Online sync`,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'ui/sync-preload.js'), sandbox: true, contextIsolation: true },
  });
  syncWindow.loadFile(path.join(__dirname, 'ui/sync.html'));
  syncWindow.once('ready-to-show', () => syncWindow.show());
  syncWindow.on('closed', () => (syncWindow = null));
}

function registerSyncIpc() {
  const fromSender = (e) => syncWindow && e.sender === syncWindow.webContents;

  ipcMain.handle('sync:get', (e) => {
    if (!fromSender(e)) return null;
    const s = syncSettings();
    return { enabled: s.enabled, dbName: s.dbName, hasUri: Boolean(s.uri), status: { ...sync?.status, text: syncStatusText() } };
  });

  // Test (and optionally save + turn on) a connection. An empty uri keeps the saved one.
  ipcMain.handle('sync:save', async (e, input) => {
    if (!fromSender(e)) return null;
    const s = syncSettings();
    const uri = String(input?.uri || '').trim() || decryptSecret(s.uri);
    const dbName = String(input?.dbName || '').trim();
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) return { ok: false, error: 'Enter a MongoDB connection string starting with mongodb+srv:// or mongodb://' };
    if (!/^[A-Za-z0-9_-]{1,38}$/.test(dbName)) return { ok: false, error: 'Database name: letters, numbers, _ or - (max 38 characters).' };
    try {
      const { client } = await checkTarget({ remoteUri: uri, dbName, installationId: config.installationId });
      await client.close();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (input?.testOnly) return { ok: true, message: 'Connection works and the database can be used.' };
    config.sync = { enabled: true, dbName, uri: encryptSecret(uri) };
    saveConfig(config);
    await restartSync();
    return { ok: true, message: 'Saved. Online sync is on.' };
  });

  ipcMain.handle('sync:disable', async (e) => {
    if (!fromSender(e)) return null;
    config.sync = { ...syncSettings(), enabled: false };
    saveConfig(config);
    await restartSync();
    return { ok: true, message: 'Online sync is off. Entries are kept on this computer only.' };
  });

  ipcMain.handle('sync:now', (e) => {
    if (!fromSender(e)) return null;
    sync?.syncNow();
    return { ok: true };
  });
}

// ---------------------------------------------------------------- processes

/** Runs a server script in a utility process. Never hangs: stops the child after `timeoutMs`. */
function runScript(relPath, env, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(paths.server, relPath), [], {
      env,
      cwd: paths.server,
      stdio: 'pipe',
      serviceName: `${APP_NAME} setup`,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: code || 1, stdout, stderr, error: `${relPath} did not finish within ${timeoutMs / 1000} seconds and was stopped.` });
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function startServer(cfg) {
  const logFile = path.join(paths.logs, 'server.log');
  rotate(logFile);
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const proc = utilityProcess.fork(path.join(paths.server, 'src/index.js'), [], {
    env: serverEnv(cfg),
    cwd: paths.server,
    stdio: 'pipe',
    serviceName: `${APP_NAME} API`,
  });
  proc.stdout?.pipe(log, { end: false });
  proc.stderr?.pipe(log, { end: false });
  proc.once('exit', (code) => {
    log.end();
    if (!quitting && mainWindow) {
      dialog.showErrorBox(APP_NAME, `The application server stopped unexpectedly (code ${code}).\n\nSee ${logFile}`);
      app.quit();
    }
  });
  return proc;
}

async function stopAll() {
  if (sync) {
    const s = sync;
    sync = null;
    await s.stop().catch(() => {});
  }
  if (server) {
    const s = server;
    server = null;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      s.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      s.kill();
    });
  }
  if (mongo) {
    const m = mongo;
    mongo = null;
    await m.stop();
  }
}

// ---------------------------------------------------------------- start-up

async function start() {
  buildMenu();
  showSplash();
  fs.mkdirSync(paths.logs, { recursive: true });

  const cfg = loadConfig();
  config = cfg;
  registerSyncIpc();
  cfg.mongoPort = await pickPort(cfg.mongoPort || PREFERRED_MONGO_PORT);
  cfg.appPort = await pickPort(cfg.appPort || PREFERRED_APP_PORT);
  saveConfig(cfg);

  const mongoLog = path.join(paths.logs, 'mongod.log');
  rotate(mongoLog);
  try {
    mongo = await startMongo({ mongodPath: paths.mongod, dbPath: paths.db, logPath: mongoLog, port: cfg.mongoPort });
  } catch (err) {
    // 0xC0000135 = a required DLL is missing (the Visual C++ runtime).
    if (/exit code (3221225781|-1073741515)/.test(err.message)) {
      err.message =
        'MongoDB could not start because the Microsoft Visual C++ Runtime is missing.\n' +
        'Reinstall the app, or install "vc_redist.x64.exe" from Microsoft, then try again.';
    }
    throw err;
  }

  if ((await mongo.countActiveAdmins()) === 0) {
    const created = await runFirstAdminSetup(cfg);
    if (!created) {
      app.quit();
      return;
    }
    showSplash();
  }

  server = startServer(cfg);
  await waitForHealth(cfg.appPort, server);
  appUrl = `http://127.0.0.1:${cfg.appPort}/`;
  createMainWindow();
  started = true;
  // Mirrors the local database online in the background; the app never waits for it.
  await restartSync().catch((err) => dialog.showErrorBox(APP_NAME, `Online sync could not start: ${err.message}`));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() =>
    start().catch(async (err) => {
      closeSplash();
      dialog.showErrorBox(`${APP_NAME} could not start`, `${err.message}\n\nLogs: ${paths.logs}`);
      quitting = true;
      await stopAll().catch(() => {});
      app.exit(1);
    }),
  );

  app.on('window-all-closed', () => {
    // During start-up windows hand over to each other (splash → setup → splash → main);
    // start() quits by itself if the setup window is closed without creating an admin.
    if (started) app.quit();
  });

  // Ctrl+C / kill during development: shut MongoDB down cleanly too.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopAll()
      .catch(() => {})
      .finally(() => app.exit(0));
  });
}
