// Draws the app's brand mark (blue rounded square, white pulse line) and writes build/icon.png and build/icon.ico.
// Run with Electron so no extra image library is needed:  npx electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const svg = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.4" fill="#2f5fe0"/>` +
  `<path d="M20 12h-3.2l-2.4 7.2L9.6 4.8 7.2 12H4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let win;
async function render(n) {
  win ??= new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  win.setContentSize(n, n);
  const page = path.join(os.tmpdir(), `webase-icon-${n}.html`);
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;overflow:hidden">${svg(n)}</body>`);
  await win.loadFile(page);
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(page, { force: true });
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: n, height: n });
  if (img.getSize().width !== n) img = img.resize({ width: n, height: n, quality: 'best' });
  return img.toPNG();
}

// An .ico file that holds PNG images (supported since Windows Vista).
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map(({ n, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(n >= 256 ? 0 : n, 0);
    e.writeUInt8(n >= 256 ? 0 : n, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const n of sizes) images.push({ n, png: await render(n) });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico(images));
  fs.writeFileSync(path.join(__dirname, 'icon.png'), await render(512));
  console.log('wrote build/icon.ico (' + sizes.join(', ') + ') and build/icon.png (512)');
  app.quit();
});
