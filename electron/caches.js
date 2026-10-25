const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { measure, limiter } = require('./sizes');
const { removeTree } = require('./cleanup');

// Caches: found by FIXED rules (a program's own folder, exact cache-folder names at exact depths), measured, and cleared on request. Browsers
// (Chrome, Edge, Brave, Vivaldi, Firefox) and a short table of other programs' caches (graphics shader caches, npm, pip, VS Code, Discord, Steam's
// web cache). Never cookies, history, passwords, bookmarks, extensions, settings or stored data. Clearing deletes the CONTENTS of those folders
// (the folders stay), never follows a link, skips files that are in use, and reports what was really freed (measured before and after).
// The window names a cache by its id; paths are rebuilt here from the rules every time.
// The roots come from the LOCALAPPDATA and APPDATA environment variables on purpose, never from Electron's app.getPath (which asks Windows
// directly and ignores them): that is what lets the tests run against a throwaway tree. Do not change it.

const PROFILE_RE = /^(Default|Profile \d+|Guest Profile)$/;
const PROFILE_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']; // inside a profile folder
const BROWSER_CACHES = ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'DawnCache']; // directly inside "User Data"
const FIREFOX_PROFILE_RE = /^[A-Za-z0-9]{8}\.[A-Za-z0-9 ._-]+$/;

const BROWSER_COST = 'The browser rebuilds it as you browse, so pages can load a little slower at first.';
const SHADER_COST = 'Games and apps rebuild it as they run, so the first launch of each game can stutter or load slower, and it grows back to about the same size.';

const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', group: 'Browsers', cost: BROWSER_COST, exes: ['chrome.exe'], kind: 'chromium', base: ['Google', 'Chrome', 'User Data'] },
  { id: 'edge', name: 'Microsoft Edge', group: 'Browsers', cost: BROWSER_COST, exes: ['msedge.exe'], kind: 'chromium', base: ['Microsoft', 'Edge', 'User Data'], note: 'Edge often keeps running in the background, so this may stay disabled with no window open. Close it from the taskbar tray or Task Manager.' },
  { id: 'brave', name: 'Brave', group: 'Browsers', cost: BROWSER_COST, exes: ['brave.exe'], kind: 'chromium', base: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { id: 'vivaldi', name: 'Vivaldi', group: 'Browsers', cost: BROWSER_COST, exes: ['vivaldi.exe'], kind: 'chromium', base: ['Vivaldi', 'User Data'] },
  { id: 'firefox', name: 'Firefox', group: 'Browsers', cost: BROWSER_COST, exes: ['firefox.exe'], kind: 'firefox', base: ['Mozilla', 'Firefox', 'Profiles'] },
];

// Other programs. Each folder is [root, ...names] with root 'local' (LOCALAPPDATA) or 'roaming' (APPDATA); every name must be a real folder, not a link.
// exes: the program must not be running (exact image names, lowercase); none listed = nothing to wait for (files in use are skipped anyway).
// Deliberately NOT here: anything named User, workspaceStorage, Backups, Local Storage, Session Storage, Cookies, Network; Stremio (cannot tell what its
// folder holds); the Android SDK; Gradle and NuGet package stores.
const TARGETS = [
  { id: 'nvidia-shader', name: 'NVIDIA shader cache', group: 'Graphics', cost: SHADER_COST, folders: [['local', 'NVIDIA', 'DXCache'], ['local', 'NVIDIA', 'GLCache']] },
  { id: 'windows-shader', name: 'DirectX shader cache', group: 'Graphics', cost: SHADER_COST, folders: [['local', 'D3DSCache']] },
  { id: 'npm', name: 'npm cache', group: 'Developer tools', cost: 'npm downloads packages again the next time an install needs them. Only the default folder is checked; a cache moved with "npm config" is not seen.', folders: [['local', 'npm-cache']] },
  { id: 'pip', name: 'pip cache', group: 'Developer tools', cost: 'pip downloads packages again the next time an install needs them.', folders: [['local', 'pip', 'Cache']] },
  {
    id: 'vscode', name: 'Visual Studio Code', group: 'Developer tools', cost: 'VS Code rebuilds it on the next start, which can be a little slower once.', exes: ['code.exe'],
    folders: [['roaming', 'Code', 'Cache'], ['roaming', 'Code', 'CachedData'], ['roaming', 'Code', 'CachedExtensionVSIXs'], ['roaming', 'Code', 'Code Cache'], ['roaming', 'Code', 'GPUCache']],
  },
  { id: 'discord', name: 'Discord', group: 'Apps', cost: 'Discord rebuilds it; images and avatars load again the first time you see them.', exes: ['discord.exe'], folders: [['roaming', 'discord', 'Cache'], ['roaming', 'discord', 'Code Cache'], ['roaming', 'discord', 'GPUCache']] },
  { id: 'steam-web', name: 'Steam web cache', group: 'Apps', cost: 'Steam rebuilds it; store and community pages load again from the internet.', exes: ['steam.exe', 'steamwebhelper.exe'], folders: [['local', 'Steam', 'htmlcache']] },
];
const ALL = [...BROWSERS, ...TARGETS];

// image names of the programs running now, lowercase (exact names: msedgewebview2.exe is not a browser window)
async function runningImages() {
  const { stdout } = await execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return new Set(stdout.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]?.toLowerCase()).filter(Boolean));
}

const defaults = () => ({ local: process.env.LOCALAPPDATA || '', roaming: process.env.APPDATA || '', fsApi: fsp, running: runningImages, budgetMs: 60000 });

// the cache folders that exist for a browser, from the fixed rules only
async function browserFolders(def, local, fsApi) {
  if (!local || !path.isAbsolute(local)) return [];
  const base = path.join(local, ...def.base);
  let entries = [];
  try {
    entries = await fsApi.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name);
  const out = [];
  if (def.kind === 'chromium') {
    for (const n of BROWSER_CACHES) if (dirs.includes(n)) out.push({ path: path.join(base, n), label: n });
    for (const p of dirs.filter((n) => PROFILE_RE.test(n))) for (const n of PROFILE_CACHES) out.push({ path: path.join(base, p, n), label: `${p}\\${n}` });
  } else {
    for (const p of dirs.filter((n) => FIREFOX_PROFILE_RE.test(n))) out.push({ path: path.join(base, p, 'cache2'), label: `${p}\\cache2` });
  }
  const real = [];
  for (const c of out) {
    const st = await fsApi.lstat(c.path).catch(() => null); // must be a real folder, not a link
    if (st && st.isDirectory() && !st.isSymbolicLink()) real.push(c);
  }
  return real;
}

// the cache folders that exist for another program: every step from the root down must be a real folder, never a link
async function targetFolders(def, roots, fsApi) {
  const found = [];
  for (const [rootKey, ...names] of def.folders) {
    const root = roots[rootKey];
    if (!root || !path.isAbsolute(root)) continue;
    let p = root;
    let real = true;
    for (const n of names) {
      p = path.join(p, n);
      const st = await fsApi.lstat(p).catch(() => null);
      if (!st || !st.isDirectory() || st.isSymbolicLink()) { real = false; break; }
    }
    if (real) found.push({ path: p, label: names.join('\\') });
  }
  return found;
}

// { bytes, partial }: partial = the walk was cut short, so bytes is a minimum
async function sizeOfDir(p, fsApi, budgetMs) {
  const m = await measure(p, { fsApi, run: limiter(16), deadline: Date.now() + budgetMs }).catch(() => ({ bytes: 0, partial: true }));
  return { bytes: m.bytes, partial: m.partial };
}

// [{ id, name, group, cost, running, note, bytes, partial, dirs: [{ path, label, bytes, partial }] }] for what has cache to clear (or is running)
async function discoverCaches(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const running = await d.running().catch(() => new Set());
  const roots = { local: d.local, roaming: d.roaming };
  const groups = [];
  for (const def of ALL) {
    const found = def.base ? await browserFolders(def, d.local, d.fsApi) : await targetFolders(def, roots, d.fsApi);
    if (!found.length) continue;
    const dirs = [];
    for (const c of found) dirs.push({ ...c, ...(await sizeOfDir(c.path, d.fsApi, d.budgetMs)) });
    groups.push({
      id: def.id, name: def.name, group: def.group, cost: def.cost, running: (def.exes ?? []).some((e) => running.has(e)), note: def.note ?? null,
      bytes: dirs.reduce((n, x) => n + x.bytes, 0), partial: dirs.some((x) => x.partial), dirs,
    });
  }
  return groups.filter((g) => g.bytes > 0 || g.running || g.partial);
}

// ids: cache ids from the latest list. Paths are rebuilt from the rules, so nothing the window says can point anywhere else.
async function clearCaches(ids, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  if (!Array.isArray(ids) || !ids.length || ids.length > ALL.length || ids.some((i) => typeof i !== 'string')) throw new Error('Nothing is selected.');
  const groups = await discoverCaches(d);
  const results = [];
  for (const id of new Set(ids)) {
    const g = groups.find((x) => x.id === id);
    if (!g) { results.push({ id, ok: false, error: 'No cache was found for that one.' }); continue; }
    if (g.running) { results.push({ id, name: g.name, ok: false, error: `${g.name} is running. Close it first, then look again.` }); continue; }
    const stats = { freed: 0, failed: 0, reasons: new Set() };
    for (const dir of g.dirs) {
      let names = [];
      try {
        names = await d.fsApi.readdir(dir.path);
      } catch {
        stats.failed++;
        continue;
      }
      for (const name of names) {
        const child = path.join(dir.path, name);
        const st = await d.fsApi.lstat(child).catch(() => null);
        if (!st) continue;
        if (st.isSymbolicLink()) { stats.failed++; stats.reasons.add('link left alone'); continue; }
        await removeTree(child, st, stats);
      }
    }
    // what was really freed: measured again, not taken from the deleting code; a walk cut short on either side makes the figure a minimum
    let after = 0;
    let partial = g.partial;
    for (const dir of g.dirs) {
      const m = await sizeOfDir(dir.path, d.fsApi, d.budgetMs);
      after += m.bytes;
      partial ||= m.partial;
    }
    results.push({ id, name: g.name, ok: true, freedBytes: Math.max(0, g.bytes - after), leftBytes: after, skipped: stats.failed, reasons: [...stats.reasons], partial });
  }
  return { results, freedBytes: results.reduce((n, r) => n + (r.freedBytes ?? 0), 0), failed: results.filter((r) => !r.ok).length };
}

module.exports = { discoverCaches, clearCaches, BROWSERS, TARGETS, PROFILE_CACHES, BROWSER_CACHES, runningImages };
