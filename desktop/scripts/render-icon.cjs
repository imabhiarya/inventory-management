// Renders build-resources/logo.svg to PNG with Chromium (exact gradients and shadows), then
// packs a multi-size Windows .ico. Run: npx electron scripts/render-icon.cjs  (needs ImageMagick)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = path.join(__dirname, '../build-resources');
const svg = fs.readFileSync(path.join(dir, 'logo.svg'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = img.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(dir, 'icon.png'), png);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  execFileSync('magick', [path.join(dir, 'icon.png'), '-background', 'none', '-define', `icon:auto-resize=${sizes.join(',')}`, path.join(dir, 'icon.ico')]);
  console.log('wrote icon.png and icon.ico');
  app.exit(0);
});
