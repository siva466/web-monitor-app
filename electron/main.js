const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { getOverview, getLive } = require('./system');
const { listSoftware, folderOf } = require('./software');
const { getProcesses, endTasks } = require('./processes');
const { listStartup, setStartup } = require('./startup');
const { scanCleanup, deleteCleanup } = require('./cleanup');
const { listDrivers, scanDriverUpdates, LINKS } = require('./drivers');
const { listAppUpdates, searchApps, appDetails, installApp, upgradeApp } = require('./winget');
const { uninstallApp, getSnapshot } = require('./uninstall');
const { scanLeftovers, manualSnapshot, stillInstalled, defaultRoots } = require('./leftovers');
const { removeLeftovers, assessItem, backupRoot } = require('./leftover-delete');
const { installDriverUpdate } = require('./driver-install');
const { listBackups, restoreKey, restoreFolder, deleteBackup, backupDir } = require('./backups');
const { listBlocked } = require('./blocked');
const disk = require('./disk');
const { scanLarge, trashLarge, annotate } = require('./downloads');
const { listBin, emptyBin } = require('./recyclebin');
const { discoverCaches, clearCaches } = require('./caches');
const { withLock } = require('./lock');
const { createLogger } = require('./log');

// Errors go to %LOCALAPPDATA%\WebaseSystemMonitor\logs\app.log (channel and message only, never the request). 'uncaughtExceptionMonitor'
// only watches, so Electron still shows its own error box.
const log = createLogger();
process.on('uncaughtExceptionMonitor', (e) => log.crash('main process', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
app.on('render-process-gone', (_e, _wc, d) => log.crash('window process', `${d.reason} (code ${d.exitCode})`));
app.on('child-process-gone', (_e, d) => log.crash(`${d.type} process`, `${d.reason} (code ${d.exitCode})`));
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) =>
  registerHandler(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      log.error(channel, e); // logged, then passed on to the window exactly as before
      throw e;
    }
  });

// The window can only call channels registered here; add new ones one at a time.
ipcMain.handle('hw:overview', getOverview);
ipcMain.handle('hw:live', getLive);
ipcMain.handle('sw:list', listSoftware);
ipcMain.handle('sw:openFolder', async (_e, key) => {
  const r = folderOf(key);
  return r.error ?? shell.openPath(r.dir); // '' on success, else an error message
});
ipcMain.handle('proc:list', getProcesses);
ipcMain.handle('proc:end', (_e, pids) => endTasks(pids));
ipcMain.handle('startup:list', listStartup);
ipcMain.handle('startup:set', (_e, id, enabled) => setStartup(id, enabled));
ipcMain.handle('clean:scan', () => scanCleanup());
ipcMain.handle('clean:delete', (_e, ids) => deleteCleanup(ids));
ipcMain.handle('apps:updates', listAppUpdates);
ipcMain.handle('apps:search', (_e, query) => searchApps(query));
ipcMain.handle('apps:details', (_e, id) => appDetails(id));
ipcMain.handle('apps:install', (_e, id) => installApp(id));
ipcMain.handle('apps:upgrade', (_e, id) => upgradeApp(id));
ipcMain.handle('sw:uninstall', (_e, key) => uninstallApp(key));
// Only the latest scan can be acted on: removal names items by the ids it gave out.
let lastScan = null;
async function scan(snapshot) {
  const installed = await listSoftware(); // read fresh, so a program installed a moment ago is seen
  if (!snapshot.key) {
    // Typed-in name: refuse if that program is still installed, or its own data would be offered as "leftovers".
    const app = stillInstalled(snapshot.name, installed);
    if (app) throw new Error(`${app.name} still appears in your installed software. Uninstall it first; otherwise its own data would be listed as leftovers.`);
  }
  lastScan = await scanLeftovers(snapshot, { installed });
  const roots = defaultRoots();
  // Tell the window which items it may offer to remove (removal checks again) and which need administrator permission.
  lastScan.items = lastScan.items.map((i) => ({ ...i, ...assessItem(i, { ownKey: lastScan.ownKey, roots }) }));
  return lastScan;
}
ipcMain.handle('sw:leftovers', (_e, key) => {
  const snapshot = getSnapshot(key); // only for an app uninstalled from here: its details were saved just before removal
  if (!snapshot) throw new Error('Leftovers can only be scanned for an app uninstalled from this window in this session.');
  return scan(snapshot);
});
ipcMain.handle('left:scanName', (_e, name, publisher) => scan(manualSnapshot(name, publisher)));
ipcMain.handle('left:remove', (_e, ids) => {
  if (!lastScan) throw new Error('Scan for leftovers first.');
  return withLock(() => removeLeftovers(lastScan, ids, { trashItem: (p) => shell.trashItem(p) }));
});
ipcMain.handle('left:reveal', (_e, id) => {
  const item = lastScan?.items.find((i) => i.id === id && i.kind !== 'registry'); // only a file or folder from the latest scan
  if (!item) throw new Error('That item is not in the latest scan.');
  shell.showItemInFolder(item.path);
});
ipcMain.handle('blk:list', () => listBlocked()); // read-only: what Windows kept in its Code Integrity log
// Backups page: the window names a backup by its folder name and an item by its number; paths and files are resolved in backups.js.
ipcMain.handle('bak:list', () => listBackups());
ipcMain.handle('bak:restoreKey', (_e, id, index) => withLock(() => restoreKey(id, index)));
ipcMain.handle('bak:restoreFolder', (_e, id, index) => withLock(() => restoreFolder(id, index)));
ipcMain.handle('bak:delete', (_e, id) => withLock(() => deleteBackup(id)));
ipcMain.handle('bak:open', async (_e, id) => shell.openPath(await backupDir(id)));
ipcMain.handle('left:openBackups', async () => {
  await fs.mkdir(backupRoot(), { recursive: true });
  return shell.openPath(backupRoot());
});
// Disk space page. The window never sends a path: a scan starts at a named place, and rows are named by the ids main gave out.
ipcMain.handle('disk:drives', () => disk.drives());
ipcMain.handle('disk:starts', () => disk.startList());
ipcMain.handle('disk:scanStart', (_e, key) => disk.scanStart(key));
ipcMain.handle('disk:scanChild', (_e, id) => disk.scanChild(id));
ipcMain.handle('disk:cancel', () => disk.cancel());
ipcMain.handle('disk:reveal', (_e, id) => shell.showItemInFolder(disk.resolve(id)));
// Large files in Downloads: only files from the latest scan, by id, and only to the Recycle Bin.
let lastLarge = new Map(); // id -> { path, name, bytes, modifiedMs }
let largeSeq = 0; // ids never repeat, so an id from an older scan is refused instead of pointing at a different file
ipcMain.handle('dl:scan', async (_e, minMb) => {
  if (typeof minMb !== 'number' || !Number.isFinite(minMb) || minMb < 1 || minMb > 1_000_000) throw new Error('Choose a size of at least 1 MB.');
  const r = await scanLarge(app.getPath('downloads'), { minBytes: Math.round(minMb * 1048576) });
  const files = (await annotate(r.files)).map((f) => ({ ...f, id: String(++largeSeq) }));
  lastLarge = new Map(files.map((f) => [f.id, { path: f.path, name: f.name, bytes: f.bytes, modifiedMs: f.modifiedMs }]));
  return { ...r, files: files.map((f) => ({ id: f.id, name: f.name, folder: f.folder, bytes: f.bytes, modifiedMs: f.modifiedMs, ageDays: f.ageDays, whyNot: f.whyNot })) };
});
ipcMain.handle('dl:trash', (_e, ids) => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 300 || !ids.every((i) => lastLarge.has(i))) throw new Error('Scan Downloads first, then choose from that list.');
  const items = [...new Set(ids)].map((i) => ({ id: i, ...lastLarge.get(i) }));
  return withLock(async () => {
    const r = await trashLarge(app.getPath('downloads'), items, { trashItem: (p) => shell.trashItem(p) });
    const byPath = new Map(items.map((i) => [i.path, i]));
    const results = r.results.map(({ path: p, bytes, ok, already, error }) => ({ id: byPath.get(p).id, name: byPath.get(p).name, bytes, ok, already: already ?? false, error: error ?? null }));
    results.filter((x) => x.ok).forEach((x) => lastLarge.delete(x.id)); // gone: the id is no longer valid
    return { results, moved: r.moved, failed: r.failed, freedBytes: r.freedBytes };
  });
});
ipcMain.handle('dl:reveal', (_e, id) => {
  const f = lastLarge.get(id);
  if (!f) throw new Error('That file is not in the latest scan.');
  shell.showItemInFolder(f.path);
});
ipcMain.handle('bin:list', () => listBin());
ipcMain.handle('bin:empty', () => withLock(() => emptyBin()));
ipcMain.handle('cache:scan', async () => (await discoverCaches()).map((g) => ({ ...g, dirs: g.dirs.map(({ label, bytes, partial }) => ({ label, bytes, partial })) }))); // labels only, no paths
ipcMain.handle('cache:clear', (_e, ids) => withLock(() => clearCaches(ids)));
ipcMain.handle('drv:list', listDrivers);
// Only an update the latest scan listed can be installed: the window names it by id, and the revision comes from this list.
let driverUpdates = new Map();
ipcMain.handle('drv:updates', async () => {
  const scan = await scanDriverUpdates();
  driverUpdates = new Map(scan.updates.filter((u) => u.id && u.revision !== null).map((u) => [u.id, u]));
  return scan;
});
ipcMain.handle('drv:install', (_e, id) => {
  const u = typeof id === 'string' ? driverUpdates.get(id.toLowerCase()) : null;
  if (!u) throw new Error('Check Windows Update first, then install from that list.');
  driverUpdates.delete(u.id); // one try per scan: check again before the next
  return withLock(() => installDriverUpdate({ id: u.id, revision: u.revision }));
});
ipcMain.handle('drv:open', (_e, key) => {
  if (!Object.hasOwn(LINKS, key)) throw new Error('Unknown link.'); // only addresses from the fixed list are ever opened
  return shell.openExternal(LINKS[key]);
});
ipcMain.handle('ui:setTheme', (_e, mode) => {
  // Also themes the window frame and makes prefers-color-scheme follow the choice.
  if (['light', 'dark', 'system'].includes(mode)) nativeTheme.themeSource = mode;
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '../dist/webase-app/browser/index.html'));
});

app.on('window-all-closed', () => app.quit());
