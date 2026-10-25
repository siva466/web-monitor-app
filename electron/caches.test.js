const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { discoverCaches, clearCaches, runningImages } = require('./caches');

const bases = [];
// The browser tests use a fake LOCALAPPDATA only; this keeps the real APPDATA (VS Code, Discord on this PC) out of them. The tests below that
// look at other programs pass their own `roaming`, and the real-PC test puts the real value back for its own run.
const REAL_APPDATA = process.env.APPDATA;
process.env.APPDATA = path.join(os.tmpdir(), 'webase-cache-test-no-such-appdata');
const write = (p, size) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
  return p;
};
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));

// A throwaway LOCALAPPDATA with Brave (cache folders plus things that must never be touched), Firefox, Chrome and Edge.
function appData() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-cache-test-'));
  bases.push(base);
  const local = path.join(base, 'Local');
  const brave = path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data');
  const keep = [
    write(path.join(brave, 'Default', 'Cookies'), 111),
    write(path.join(brave, 'Default', 'Login Data'), 112),
    write(path.join(brave, 'Default', 'Network', 'Cookies'), 113),
    write(path.join(brave, 'Default', 'Local Storage', 'leveldb', 'ls'), 114),
    write(path.join(brave, 'Default', 'IndexedDB', 'db'), 115),
    write(path.join(brave, 'Default', 'Service Worker', 'CacheStorage', 'c'), 116), // an app's data, though named like a cache
    write(path.join(brave, 'Default', 'Extensions', 'abc', '1.0', 'Cache', 'e'), 117),
    write(path.join(brave, 'Profile X', 'Cache', 'n'), 118), // not a profile folder name
    write(path.join(brave, 'System Profile', 'Cache', 's'), 119),
    write(path.join(brave, 'Local State'), 120),
    write(path.join(brave, 'Default', 'Preferences'), 121),
  ];
  // cache folders: 1000 + 500 + 300 + 200 + 400 = 2400
  write(path.join(brave, 'GrShaderCache', 'a.bin'), 1000);
  write(path.join(brave, 'Default', 'Cache', 'Cache_Data', 'f1'), 500);
  write(path.join(brave, 'Default', 'Code Cache', 'js', 'x'), 300);
  write(path.join(brave, 'Default', 'GPUCache', 'g'), 200);
  write(path.join(brave, 'Profile 1', 'Cache', 'z'), 400);
  const fx = path.join(local, 'Mozilla', 'Firefox', 'Profiles');
  write(path.join(fx, 'abcd1234.default-release', 'cache2', 'entries', 'e'), 700);
  keep.push(write(path.join(fx, 'abcd1234.default-release', 'cookies.sqlite'), 130));
  keep.push(write(path.join(fx, 'notaprofile', 'cache2', 'x'), 131));
  write(path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'c'), 900);
  write(path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'c'), 50);
  return { base, local, brave, keep };
}
const none = async () => new Set();
const by = (groups, id) => groups.find((g) => g.id === id);

test('finds each browser\'s caches by fixed rules and counts only those: cookies, logins, storage, extensions and look-alike folders are never included', async () => {
  const { local } = appData();
  const groups = await discoverCaches({ local, running: none });
  assert.deepEqual(groups.map((g) => [g.id, g.bytes]), [['chrome', 900], ['edge', 50], ['brave', 2400], ['firefox', 700]]);
  assert.deepEqual(by(groups, 'brave').dirs.map((d) => [d.label, d.bytes]), [['GrShaderCache', 1000], ['Default\\Cache', 500], ['Default\\Code Cache', 300], ['Default\\GPUCache', 200], ['Profile 1\\Cache', 400]]);
  assert.deepEqual(by(groups, 'firefox').dirs.map((d) => d.label), ['abcd1234.default-release\\cache2']);
  assert.ok(groups.every((g) => g.running === false));
});

test('a browser that is running is marked so, by its exact program name; its helper programs do not count', async () => {
  const { local } = appData();
  const withBrave = await discoverCaches({ local, running: async () => new Set(['brave.exe', 'msedgewebview2.exe', 'explorer.exe']) });
  assert.deepEqual(withBrave.map((g) => [g.id, g.running]), [['chrome', false], ['edge', false], ['brave', true], ['firefox', false]]);
  assert.match(by(withBrave, 'edge').note, /Edge often keeps running in the background/);
  assert.equal(by(withBrave, 'brave').note, null);
  const failed = await discoverCaches({ local, running: async () => { throw new Error('tasklist failed'); } });
  assert.equal(failed.length, 4, 'if the running programs cannot be read, the list still works');
});

test('a browser with nothing to clear is hidden, unless it is running (so the page can say why it is greyed out)', async () => {
  const { local } = appData();
  fs.mkdirSync(path.join(local, 'Vivaldi', 'User Data', 'Default', 'Cache'), { recursive: true });
  assert.equal(by(await discoverCaches({ local, running: none }), 'vivaldi'), undefined);
  const g = by(await discoverCaches({ local, running: async () => new Set(['vivaldi.exe']) }), 'vivaldi');
  assert.deepEqual([g.bytes, g.running], [0, true]);
});

test('no local app-data folder, or a relative one, finds nothing', async () => {
  assert.deepEqual(await discoverCaches({ local: '', running: none }), []);
  assert.deepEqual(await discoverCaches({ local: 'Local', running: none }), []);
});

test('a cache folder that is really a link is not a cache folder', async () => {
  const { base, local, brave } = appData();
  write(path.join(base, 'elsewhere', 'big'), 5000);
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(brave, 'Default', 'Cache2'), 'junction'); // not in the rules anyway
  fs.rmSync(path.join(brave, 'Default', 'GPUCache'), { recursive: true });
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(brave, 'Default', 'GPUCache'), 'junction');
  const g = by(await discoverCaches({ local, running: none }), 'brave');
  assert.ok(!g.dirs.some((d) => d.label.endsWith('GPUCache')));
  assert.equal(g.bytes, 2400 - 200);
});

test('clearing deletes the contents of the cache folders only: the folders stay, everything else stays, other browsers are untouched', async () => {
  const { local, brave, keep } = appData();
  const r = await clearCaches(['brave'], { local, running: none });
  assert.deepEqual([r.failed, r.freedBytes], [0, 2400]);
  assert.deepEqual(r.results.map((x) => [x.id, x.ok, x.freedBytes, x.leftBytes, x.skipped]), [['brave', true, 2400, 0, 0]]);
  for (const f of keep) assert.ok(fs.existsSync(f), f);
  for (const d of ['GrShaderCache', 'Default\\Cache', 'Default\\Code Cache', 'Default\\GPUCache', 'Profile 1\\Cache']) {
    assert.ok(fs.statSync(path.join(brave, d)).isDirectory(), `${d} stays`);
    assert.deepEqual(fs.readdirSync(path.join(brave, d)), [], `${d} is empty`);
  }
  assert.ok(fs.existsSync(path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'c')));
  assert.ok(fs.existsSync(path.join(local, 'Mozilla', 'Firefox', 'Profiles', 'abcd1234.default-release', 'cache2', 'entries', 'e')));
  const again = await clearCaches(['brave'], { local, running: none });
  assert.deepEqual(again.results.map((x) => [x.ok, x.error]), [[false, 'No cache was found for that one.']], 'nothing left to clear');
});

test('several browsers can be cleared at once; each is reported on its own', async () => {
  const { local } = appData();
  const r = await clearCaches(['firefox', 'chrome'], { local, running: none });
  assert.deepEqual(r.results.map((x) => [x.id, x.freedBytes]), [['firefox', 700], ['chrome', 900]]);
  assert.equal(r.freedBytes, 1600);
});

test('a browser that is running is refused and nothing in it is touched', async () => {
  const { local, brave } = appData();
  const r = await clearCaches(['brave', 'chrome'], { local, running: async () => new Set(['brave.exe']) });
  assert.deepEqual(r.results.map((x) => [x.id, x.ok]), [['brave', false], ['chrome', true]]);
  assert.match(r.results[0].error, /Brave is running/);
  assert.equal(r.failed, 1);
  assert.ok(fs.existsSync(path.join(brave, 'GrShaderCache', 'a.bin')));
});

test('only browser ids are accepted: anything else clears nothing', async () => {
  const { local, brave, keep } = appData();
  for (const bad of [undefined, null, 'brave', [], [1], [null], [{}], ['brave', 7], new Array(13).fill('brave')]) {
    await assert.rejects(() => clearCaches(bad, { local, running: none }), /Nothing is selected/, JSON.stringify(bad));
  }
  const r = await clearCaches(['..\\..\\Windows', 'C:\\Users', 'netscape', 'default'], { local, running: none });
  assert.ok(r.results.every((x) => x.ok === false && /No cache was found/.test(x.error)));
  assert.ok(fs.existsSync(path.join(brave, 'GrShaderCache', 'a.bin')));
  for (const f of keep) assert.ok(fs.existsSync(f));
});

test('a link inside a cache folder is left alone and what it points to is not deleted', async () => {
  const { base, local, brave } = appData();
  const outside = write(path.join(base, 'elsewhere', 'precious'), 5000);
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(brave, 'Default', 'Cache', 'portal'), 'junction');
  const r = await clearCaches(['brave'], { local, running: none });
  assert.ok(fs.existsSync(outside), 'the target of the link is intact');
  assert.equal(r.results[0].freedBytes, 2400);
  assert.ok(r.results[0].skipped >= 1);
  assert.ok(r.results[0].reasons.includes('link left alone'));
});

test('a file in use is skipped and reported, the freed figure counts only what was removed', { skip: process.platform !== 'win32' }, async () => {
  const { local, brave } = appData();
  const locked = path.join(brave, 'Default', 'Cache', 'Cache_Data', 'locked');
  write(locked, 250);
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${locked}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock was not taken')), 15000);
      holder.stdout.on('data', (d) => {
        if (String(d).includes('locked')) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.on('error', reject);
    });
    const r = await clearCaches(['brave'], { local, running: none });
    const b = r.results[0];
    assert.deepEqual([b.ok, b.freedBytes, b.leftBytes], [true, 2400, 250]);
    assert.ok(b.skipped >= 1 && b.reasons.length > 0, JSON.stringify(b));
    assert.ok(fs.existsSync(locked));
    assert.ok(!fs.existsSync(path.join(brave, 'GrShaderCache', 'a.bin')));
    console.log('  reason reported for the locked file:', b.reasons);
  } finally {
    holder.kill();
  }
});

test('the real list of running programs includes this one (and is made of exact lowercase program names)', async () => {
  const names = await runningImages();
  assert.ok(names.has('node.exe'), [...names].slice(0, 10).join(','));
  assert.ok([...names].every((n) => n === n.toLowerCase()));
});

test('the real discovery on this PC is read-only and returns well-formed groups', async () => {
  process.env.APPDATA = REAL_APPDATA;
  let groups;
  try {
    groups = await discoverCaches();
  } finally {
    process.env.APPDATA = path.join(os.tmpdir(), 'webase-cache-test-no-such-appdata');
  }
  for (const g of groups) {
    assert.ok(typeof g.id === 'string' && typeof g.name === 'string' && typeof g.group === 'string' && typeof g.cost === 'string' && typeof g.running === 'boolean' && typeof g.partial === 'boolean' && Number.isFinite(g.bytes), JSON.stringify(g));
    assert.ok(g.dirs.every((d) => path.isAbsolute(d.path) && Number.isFinite(d.bytes)));
  }
});

// ---- other programs' caches ----

// A throwaway LOCALAPPDATA and APPDATA with every target, and things that must never be touched next to them.
function programs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-cache-apps-'));
  bases.push(base);
  const local = path.join(base, 'Local');
  const roaming = path.join(base, 'Roaming');
  const keep = [
    write(path.join(roaming, 'discord', 'Local Storage', 'leveldb', 'ls'), 101), write(path.join(roaming, 'discord', 'Session Storage', 's'), 102),
    write(path.join(roaming, 'discord', 'Network', 'Cookies'), 103), write(path.join(roaming, 'discord', 'settings.json'), 104),
    write(path.join(roaming, 'Code', 'User', 'settings.json'), 105), write(path.join(roaming, 'Code', 'User', 'workspaceStorage', 'w', 'state.vscdb'), 106),
    write(path.join(roaming, 'Code', 'Backups', 'b'), 107), write(path.join(roaming, 'Code', 'logs', 'l'), 108),
    write(path.join(local, 'Steam', 'config', 'config.vdf'), 109), write(path.join(local, 'Steam', 'userdata', 'u'), 110),
    write(path.join(local, 'Stremio', 'cache', 'big'), 111), // not in the table: never touched
    write(path.join(local, 'Android', 'Sdk', 'tool'), 112),
    write(path.join(local, 'NVIDIA', 'settings.bin'), 113), // beside the cache folders, not in them
    write(path.join(local, 'npm-cache.txt'), 114),
  ];
  write(path.join(local, 'NVIDIA', 'DXCache', 'a.bin'), 6000);
  write(path.join(local, 'NVIDIA', 'GLCache', 'g.bin'), 500);
  write(path.join(local, 'D3DSCache', 'XXXX', 'd.bin'), 2000);
  write(path.join(local, 'npm-cache', '_cacache', 'content', 'c'), 700);
  write(path.join(local, 'pip', 'Cache', 'http', 'p'), 25);
  write(path.join(roaming, 'Code', 'Cache', 'a'), 30);
  write(path.join(roaming, 'Code', 'CachedData', 'b'), 50);
  write(path.join(roaming, 'Code', 'CachedExtensionVSIXs', 'v'), 140);
  write(path.join(roaming, 'discord', 'Cache', 'x'), 240);
  write(path.join(roaming, 'discord', 'GPUCache', 'g'), 5);
  write(path.join(local, 'Steam', 'htmlcache', 'h'), 380);
  return { base, local, roaming, keep };
}
const apps = (t, over = {}) => ({ local: t.local, roaming: t.roaming, running: none, ...over });
const names = (groups) => groups.map((g) => [g.id, g.group, g.bytes]);

test('other programs: found by fixed rules, in groups, with only their cache folders counted', async () => {
  const t = programs();
  const groups = await discoverCaches(apps(t));
  assert.deepEqual(names(groups), [
    ['nvidia-shader', 'Graphics', 6500], ['windows-shader', 'Graphics', 2000], ['npm', 'Developer tools', 700], ['pip', 'Developer tools', 25],
    ['vscode', 'Developer tools', 220], ['discord', 'Apps', 245], ['steam-web', 'Apps', 380],
  ]);
  assert.deepEqual(by(groups, 'nvidia-shader').dirs.map((d) => d.label), ['NVIDIA\\DXCache', 'NVIDIA\\GLCache']);
  assert.deepEqual(by(groups, 'vscode').dirs.map((d) => d.label), ['Code\\Cache', 'Code\\CachedData', 'Code\\CachedExtensionVSIXs']);
  assert.ok(groups.every((g) => g.cost.length > 20 && g.partial === false && g.running === false && g.note === null));
  assert.match(by(groups, 'windows-shader').cost, /first launch of each game can stutter/);
});

test('other programs: a program that is not installed (no folder) or has nothing in its cache is not listed, unless it is running', async () => {
  const t = programs();
  fs.rmSync(path.join(t.local, 'Steam', 'htmlcache'), { recursive: true });
  fs.mkdirSync(path.join(t.local, 'Steam', 'htmlcache'));
  fs.rmSync(path.join(t.local, 'pip'), { recursive: true });
  const quiet = await discoverCaches(apps(t));
  assert.ok(!quiet.some((g) => g.id === 'steam-web' || g.id === 'pip'));
  const running = await discoverCaches(apps(t, { running: async () => new Set(['steamwebhelper.exe']) }));
  assert.deepEqual([by(running, 'steam-web').bytes, by(running, 'steam-web').running], [0, true]);
  assert.equal(by(running, 'pip'), undefined, 'no folder at all: nothing to show even if the program ran');
  assert.deepEqual(await discoverCaches({ local: '', roaming: '', running: none }), []);
  assert.deepEqual(await discoverCaches({ local: 'Local', roaming: 'Roaming', running: none }), []);
});

test('other programs: running is decided by exact program names, and Steam counts as running through its web helper too', async () => {
  const t = programs();
  const r = (...n) => discoverCaches(apps(t, { running: async () => new Set(n) }));
  const flags = (groups) => Object.fromEntries(groups.map((g) => [g.id, g.running]));
  assert.deepEqual(flags(await r('steam.exe')), { 'nvidia-shader': false, 'windows-shader': false, npm: false, pip: false, vscode: false, discord: false, 'steam-web': true });
  assert.equal(flags(await r('steamwebhelper.exe'))['steam-web'], true);
  assert.equal(flags(await r('code.exe')).vscode, true);
  assert.equal(flags(await r('discord.exe')).discord, true);
  const other = flags(await r('code - insiders.exe', 'discordptb.exe', 'steamservice.exe', 'node.exe', 'msedgewebview2.exe'));
  assert.ok(Object.values(other).every((v) => v === false), JSON.stringify(other));
});

test('other programs: clearing deletes the contents of the cache folders only; folders stay; settings, stored data and other programs are untouched', async () => {
  const t = programs();
  const r = await clearCaches(['nvidia-shader', 'windows-shader', 'npm', 'pip', 'vscode', 'discord', 'steam-web'], apps(t));
  assert.deepEqual([r.failed, r.freedBytes], [0, 6500 + 2000 + 700 + 25 + 220 + 245 + 380]);
  for (const f of t.keep) assert.ok(fs.existsSync(f), f);
  for (const d of [['Local', 'NVIDIA', 'DXCache'], ['Local', 'NVIDIA', 'GLCache'], ['Local', 'D3DSCache'], ['Local', 'npm-cache'], ['Local', 'pip', 'Cache'], ['Roaming', 'Code', 'Cache'], ['Roaming', 'Code', 'CachedData'], ['Roaming', 'Code', 'CachedExtensionVSIXs'], ['Roaming', 'discord', 'Cache'], ['Roaming', 'discord', 'GPUCache'], ['Local', 'Steam', 'htmlcache']]) {
    const p = path.join(t.base, ...d);
    assert.ok(fs.statSync(p).isDirectory(), `${d.join('\\')} stays`);
    assert.deepEqual(fs.readdirSync(p), [], `${d.join('\\')} is empty`);
  }
  assert.deepEqual(r.results.map((x) => [x.id, x.ok, x.leftBytes, x.skipped, x.partial]), ['nvidia-shader', 'windows-shader', 'npm', 'pip', 'vscode', 'discord', 'steam-web'].map((id) => [id, true, 0, 0, false]));
});

test('other programs: only the chosen ones are cleared, a running one is refused, and a repeated id is cleared once', async () => {
  const t = programs();
  const r = await clearCaches(['npm', 'npm', 'discord'], apps(t, { running: async () => new Set(['discord.exe']) }));
  assert.deepEqual(r.results.map((x) => [x.id, x.ok]), [['npm', true], ['discord', false]]);
  assert.match(r.results[1].error, /Discord is running/);
  assert.equal(r.freedBytes, 700);
  assert.ok(fs.existsSync(path.join(t.roaming, 'discord', 'Cache', 'x')) && fs.existsSync(path.join(t.local, 'D3DSCache', 'XXXX', 'd.bin')));
});

test('other programs: ids are checked: nothing else is accepted and no path can be named', async () => {
  const t = programs();
  const { BROWSERS, TARGETS } = require('./caches');
  for (const bad of [undefined, null, 'npm', [], [1], [null], new Array(BROWSERS.length + TARGETS.length + 1).fill('npm')]) {
    await assert.rejects(() => clearCaches(bad, apps(t)), /Nothing is selected/, JSON.stringify(bad));
  }
  const r = await clearCaches(['..\\..\\Windows', 'C:\\Users', 'Code', 'NVIDIA\\DXCache', 'stremio'], apps(t));
  assert.ok(r.results.every((x) => x.ok === false && /No cache was found/.test(x.error)));
  for (const f of t.keep) assert.ok(fs.existsSync(f));
  assert.equal(fs.readdirSync(path.join(t.local, 'NVIDIA', 'DXCache')).length, 1);
});

test('other programs: a link anywhere on the way down makes the folder not count, and a link inside is left alone with its target intact', async () => {
  const t = programs();
  write(path.join(t.base, 'elsewhere', 'precious'), 5000);
  fs.rmSync(path.join(t.local, 'D3DSCache'), { recursive: true });
  fs.symlinkSync(path.join(t.base, 'elsewhere'), path.join(t.local, 'D3DSCache'), 'junction'); // the cache folder itself is a link
  fs.symlinkSync(path.join(t.base, 'elsewhere'), path.join(t.roaming, 'Code', 'Cache', 'portal'), 'junction'); // a link inside a cache folder
  const nv = path.join(t.local, 'NVIDIA');
  fs.renameSync(nv, path.join(t.base, 'NVIDIA-real'));
  fs.symlinkSync(path.join(t.base, 'NVIDIA-real'), nv, 'junction'); // a link above the cache folders
  const groups = await discoverCaches(apps(t));
  assert.ok(!groups.some((g) => g.id === 'windows-shader' || g.id === 'nvidia-shader'), 'neither is offered');
  const r = await clearCaches(['vscode', 'windows-shader', 'nvidia-shader'], apps(t));
  assert.deepEqual(r.results.map((x) => [x.id, x.ok]), [['vscode', true], ['windows-shader', false], ['nvidia-shader', false]]);
  assert.ok(r.results[0].skipped >= 1 && r.results[0].reasons.includes('link left alone'));
  assert.ok(fs.existsSync(path.join(t.base, 'elsewhere', 'precious')), 'the target of the links is intact');
  assert.ok(fs.existsSync(path.join(t.base, 'NVIDIA-real', 'DXCache', 'a.bin')));
});

test('other programs: a file in use is skipped and reported, and "freed" plus "left" equals what was there', { skip: process.platform !== 'win32' }, async () => {
  const t = programs();
  const locked = write(path.join(t.local, 'NVIDIA', 'DXCache', 'locked.bin'), 400);
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${locked}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock was not taken')), 15000);
      holder.stdout.on('data', (d) => { if (String(d).includes('locked')) { clearTimeout(timer); resolve(); } });
      holder.on('error', reject);
    });
    const before = by(await discoverCaches(apps(t)), 'nvidia-shader').bytes;
    const r = await clearCaches(['nvidia-shader'], apps(t));
    const x = r.results[0];
    assert.equal(before, 6900);
    assert.deepEqual([x.ok, x.freedBytes, x.leftBytes, x.freedBytes + x.leftBytes], [true, 6500, 400, before]);
    assert.ok(x.skipped >= 1 && x.reasons.includes('in use'), JSON.stringify(x));
    assert.ok(fs.existsSync(locked) && !fs.existsSync(path.join(t.local, 'NVIDIA', 'DXCache', 'a.bin')));
  } finally {
    holder.kill();
  }
});

test('a measurement that was cut short is marked partial, and so is the freed figure built from it (shown as "at least")', async () => {
  const t = programs();
  const groups = await discoverCaches(apps(t, { budgetMs: -1 })); // the time budget is already over
  assert.ok(groups.length > 0 && groups.every((g) => g.partial === true && g.dirs.every((d) => d.partial === true)));
  const r = await clearCaches(['npm'], apps(t, { budgetMs: -1 }));
  assert.equal(r.results[0].partial, true);
  assert.equal((await discoverCaches(apps(t))).every((g) => g.partial === false), true, 'with the normal budget nothing is partial');
});
