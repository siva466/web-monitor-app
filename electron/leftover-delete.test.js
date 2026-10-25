const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeLeftovers, assessItem, whyRegistryRefused, whyFileRefused } = require('./leftover-delete');
const { runElevated } = require('./leftover-admin');

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));

// A throwaway world: folders for files, a fake Recycle Bin, and an in-memory registry. Nothing real is touched.
function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-ldel-test-'));
  bases.push(base);
  const roots = { files: ['appdata', 'local', 'pf'].map((d) => path.join(base, d)), registry: [] };
  roots.files.forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const registry = new Map(); // key -> { subkeys, values }
  const log = [];
  const jobs = []; // what was handed to the administrator step
  const pf = path.join(base, 'pf'); // stands for Program Files: an all-users place
  const deps = {
    backupRoot: path.join(base, 'backups'),
    roots,
    now: Date.UTC(2026, 9, 25, 12, 0, 0),
    trashItem: async (p) => { log.push(`trash ${path.basename(p)}`); fs.renameSync(p, path.join(bin, `${log.length}-${path.basename(p)}`)); },
    exportKey: async (key, file) => { log.push(`export ${key}`); fs.writeFileSync(file, `Windows Registry Editor\r\n[${key}]\r\n`); },
    deleteKey: async (key) => {
      log.push(`delete ${key}`);
      for (const k of [...registry.keys()]) if (k.toLowerCase() === key.toLowerCase() || k.toLowerCase().startsWith(key.toLowerCase() + '\\')) registry.delete(k);
      const parent = registry.get(key.slice(0, key.lastIndexOf('\\')));
      if (parent) parent.subkeys -= 1; // like the real registry: the parent now has one subkey fewer
    },
    keyInfo: async (key) => registry.get(key) ?? null,
    binInfo: async () => ({ driveType: 3, nuke: false, maxBytes: null }), // a normal fixed drive with a normal Recycle Bin
    isAllUsers: (p) => path.resolve(p).toLowerCase().startsWith(pf.toLowerCase() + path.sep),
    trashTimeoutMs: 5000,
  };
  const w = { base, roots, bin, registry, log, jobs, pf, deps };
  deps.runElevated = fakeAdmin(w);
  return w;
}

// Stands in for the administrator step: does what the real script does, in memory and in the throwaway folders.
function fakeAdmin(w, { lie = false, skipBackup = false } = {}) {
  return async (job) => {
    w.jobs.push(job);
    const out = [];
    for (const i of job.items) {
      if (!lie) {
        if (i.kind === 'registry') {
          if (!skipBackup) await w.deps.exportKey(i.path, i.backup);
          await w.deps.deleteKey(i.path);
        } else fs.rmdirSync(i.path);
      }
      out.push({ id: i.id, ok: true, error: null });
    }
    return out;
  };
}
const put = (p, size = 100) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); };
const item = (over) => ({ kind: 'folder', confidence: 'medium', reason: 'x', sizeBytes: 1, entries: null, hasLinks: false, empty: false, ...over });
const scanOf = (items, over = {}) => ({ name: 'PuTTY release 0.85 (64-bit)', publisher: 'Simon Tatham', ownKey: null, items: items.map((it, i) => ({ id: String(i), ...it })), ...over });
const KEY = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY';

test('a registry key is backed up first, then removed; a folder goes to the Recycle Bin; a manifest is written', async () => {
  const w = world();
  put(path.join(w.base, 'appdata', 'PuTTY', 'putty.rnd'), 600);
  w.registry.set(KEY, { subkeys: 1, values: 0 });
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'PuTTY') }), item({ kind: 'registry', path: KEY })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);

  assert.deepEqual([r.removed, r.failed], [2, 0]);
  assert.deepEqual(w.log, [`export ${KEY}`, `delete ${KEY}`, 'trash PuTTY']); // the backup comes before the delete
  assert.ok(!fs.existsSync(path.join(w.base, 'appdata', 'PuTTY')));
  assert.ok(fs.existsSync(path.join(w.bin, '3-PuTTY', 'putty.rnd')), 'the folder is recoverable from the bin');
  const backups = fs.readdirSync(r.backupDir);
  assert.ok(backups.some((f) => f.endsWith('.reg')) && backups.includes('manifest.json'));
  assert.match(path.basename(r.backupDir), /^2026-10-25T12-00-00-PuTTY-release-0-85-64-bit$/);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.results.length, 2);
  assert.equal(manifest.format, 2);
  const how = (p) => manifest.results.find((x) => x.path === p);
  assert.equal(how(KEY).method, 'reg-export');
  assert.ok(fs.existsSync(path.join(r.backupDir, how(KEY).backupFile)), 'the manifest names the .reg file that holds the key');
  assert.deepEqual([how(path.join(w.base, 'appdata', 'PuTTY')).method, how(path.join(w.base, 'appdata', 'PuTTY')).backupFile], ['recycle-bin', undefined]);
});

test('no backup, no delete: if the export fails the key stays', async () => {
  const w = world();
  w.registry.set(KEY, { subkeys: 0, values: 2 });
  w.deps.exportKey = async () => { throw new Error('disk full'); };
  const r = await removeLeftovers(scanOf([item({ kind: 'registry', path: KEY })]), ['0'], w.deps);
  assert.equal(r.failed, 1);
  assert.match(r.results[0].error, /could not be backed up/);
  assert.ok(w.registry.has(KEY));
  assert.ok(!w.log.some((l) => l.startsWith('delete')));
});

test('an empty backup file counts as a failed backup', async () => {
  const w = world();
  w.registry.set(KEY, { subkeys: 0, values: 1 });
  w.deps.exportKey = async (key, file) => fs.writeFileSync(file, '');
  const r = await removeLeftovers(scanOf([item({ kind: 'registry', path: KEY })]), ['0'], w.deps);
  assert.equal(r.failed, 1);
  assert.ok(w.registry.has(KEY));
});

test('an item too big for the Recycle Bin is left alone, because Windows may delete it for good instead', async () => {
  const w = world();
  put(path.join(w.base, 'appdata', 'BigApp', 'huge.bin'), 5000);
  put(path.join(w.base, 'appdata', 'SmallApp', 'tiny.bin'), 10);
  w.deps.binLimit = 1000;
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'BigApp') }), item({ kind: 'folder', path: path.join(w.base, 'appdata', 'SmallApp') })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.match(r.results.find((x) => x.path.endsWith('BigApp')).error, /too big/);
  assert.ok(fs.existsSync(path.join(w.base, 'appdata', 'BigApp', 'huge.bin')));
  assert.equal(r.results.find((x) => x.path.endsWith('SmallApp')).ok, true);
  assert.deepEqual(w.log, ['trash SmallApp']);
});

test('nothing is moved when the drive would delete it for good: no Recycle Bin, "delete immediately", or a tiny bin', async () => {
  for (const [bin, expected] of [
    [{ driveType: 4, nuke: false, maxBytes: null }, /no Recycle Bin/], // network drive
    [{ driveType: 3, nuke: true, maxBytes: null }, /delete files immediately/], // "Don't move files to the Recycle Bin"
    [{ driveType: 3, nuke: false, maxBytes: 100 }, /too big/], // the bin's own limit is smaller than the item (items may use half of it)
  ]) {
    const w = world();
    put(path.join(w.base, 'appdata', 'DemoApp', 'data.bin'), 80);
    w.deps.binInfo = async () => bin;
    const r = await removeLeftovers(scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'DemoApp') })]), ['0'], w.deps);
    assert.match(r.results[0].error, expected);
    assert.ok(fs.existsSync(path.join(w.base, 'appdata', 'DemoApp', 'data.bin')));
    assert.deepEqual(w.log, []);
  }
});

test('if the Recycle Bin setting cannot be read, nothing is removed (fail closed); it is read once per drive', async () => {
  const w = world();
  put(path.join(w.base, 'appdata', 'AlphaApp', 'a.txt'));
  put(path.join(w.base, 'appdata', 'BetaApp', 'b.txt'));
  w.deps.binInfo = async () => { throw new Error('boom'); };
  const r = await removeLeftovers(scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'AlphaApp') })]), ['0'], w.deps);
  assert.match(r.results[0].error, /could not be checked/);
  assert.ok(fs.existsSync(path.join(w.base, 'appdata', 'AlphaApp', 'a.txt')));
  let calls = 0;
  w.deps.binInfo = async () => { calls++; return { driveType: 3, nuke: false, maxBytes: null }; };
  const r2 = await removeLeftovers(scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'AlphaApp') }), item({ kind: 'folder', path: path.join(w.base, 'appdata', 'BetaApp') })]), ['0', '1'], w.deps);
  assert.equal(r2.removed, 2);
  assert.equal(calls, 1);
});

const HKLM = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\SimonTatham\\PuTTY';

test('all-users items go in ONE administrator step: an empty folder and an HKLM key (backed up first); user items still use the Recycle Bin', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.pf, 'PuTTY'));
  put(path.join(w.base, 'appdata', 'PuTTY', 'putty.rnd'));
  w.registry.set(HKLM, { subkeys: 0, values: 2 });
  const scan = scanOf([
    item({ kind: 'folder', path: path.join(w.pf, 'PuTTY'), empty: true }),
    item({ kind: 'registry', path: HKLM }),
    item({ kind: 'folder', path: path.join(w.base, 'appdata', 'PuTTY') }),
  ]);
  const r = await removeLeftovers(scan, ['0', '1', '2'], w.deps);

  assert.deepEqual([r.removed, r.failed], [3, 0]);
  const m = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'manifest.json'), 'utf8')).results;
  assert.deepEqual(m.map((x) => [path.basename(x.path), x.method]).sort(), [['PuTTY', 'admin-empty-folder'], ['PuTTY', 'recycle-bin'], ['PuTTY', 'reg-export']].sort(), 'each removal says how it can be put back');
  assert.match(m.find((x) => x.kind === 'registry').backupFile, /\.reg$/);
  assert.equal(w.jobs.length, 1, 'Windows is asked once');
  const job = w.jobs[0];
  assert.deepEqual(job.items.map((i) => i.id).sort(), ['0', '1'], 'both all-users items, and only those');
  const reg = job.items.find((i) => i.kind === 'registry');
  assert.ok(reg.backup.startsWith(r.backupDir) && reg.backup.endsWith('.reg'), 'the backup goes in the backup folder');
  assert.deepEqual(job.roots, [w.pf], 'the helper is told to work only inside the all-users folders');
  assert.ok(!fs.existsSync(path.join(w.pf, 'PuTTY')));
  assert.ok(!w.registry.has(HKLM));
  assert.ok(fs.statSync(reg.backup).size > 0);
  assert.ok(fs.existsSync(path.join(w.bin, '1-PuTTY', 'putty.rnd')), 'the user folder went to the bin');
  assert.ok(w.log.indexOf(`export ${HKLM}`) < w.log.indexOf(`delete ${HKLM}`));
});

test('what cannot be done in the administrator step never reaches it, and Windows is not asked', async () => {
  const w = world();
  put(path.join(w.pf, 'Full', 'keep.txt'));
  put(path.join(w.pf, 'one.txt'));
  w.registry.set(HKLM, { subkeys: 1, values: 0 });
  const scan = scanOf([
    item({ kind: 'folder', path: path.join(w.pf, 'Full'), empty: false }), // not empty
    item({ kind: 'file', path: path.join(w.pf, 'one.txt') }), // a file
    item({ kind: 'folder', path: path.join(w.pf, 'Gone'), empty: true }), // already gone
    item({ kind: 'registry', path: HKLM, confidence: 'low', empty: false }), // may belong to other apps
    item({ kind: 'registry', path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows', confidence: 'high' }),
  ]);
  const r = await removeLeftovers(scan, ['0', '1', '2', '3', '4'], w.deps);
  assert.equal(w.jobs.length, 0, 'no administrator step, so no permission prompt');
  const ok = (p) => r.results.find((x) => x.path === p).ok;
  assert.deepEqual([path.join(w.pf, 'Full'), path.join(w.pf, 'one.txt'), path.join(w.pf, 'Gone'), HKLM, 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows'].map(ok), [false, false, true, false, false]);
  assert.match(r.results.find((x) => x.path === path.join(w.pf, 'Full')).error, /Show in folder/);
  assert.ok(fs.existsSync(path.join(w.pf, 'Full', 'keep.txt')) && fs.existsSync(path.join(w.pf, 'one.txt')));
  assert.ok(w.registry.has(HKLM));
  assert.deepEqual(w.log, []);
  assert.equal(r.backupDir, null);
  assert.ok(!fs.existsSync(w.deps.backupRoot), 'nothing happened, so no backup folder is left');
});

test('a folder that gained a file after the scan is refused by the check just before the prompt, and a link is never followed', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.pf, 'WasEmpty'));
  fs.writeFileSync(path.join(w.pf, 'WasEmpty', 'new.txt'), 'x');
  const outside = path.join(w.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(w.pf, 'LinkApp'), 'junction');
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.pf, 'WasEmpty'), empty: true }), item({ kind: 'folder', path: path.join(w.pf, 'LinkApp'), empty: true })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.equal(r.failed, 2);
  assert.match(r.results.find((x) => x.path.endsWith('WasEmpty')).error, /not empty/);
  assert.match(r.results.find((x) => x.path.endsWith('LinkApp')).error, /link/);
  assert.equal(w.jobs.length, 0);
  assert.ok(fs.existsSync(outside) && fs.existsSync(path.join(w.pf, 'WasEmpty', 'new.txt')));
});

test('declining the Windows prompt changes nothing and says so; no empty backup folder is left', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.pf, 'PuTTY'));
  w.registry.set(HKLM, { subkeys: 0, values: 1 });
  w.deps.runElevated = async () => { throw Object.assign(new Error('The Windows permission prompt was declined, so nothing changed.'), { code: 'DECLINED' }); };
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.pf, 'PuTTY'), empty: true }), item({ kind: 'registry', path: HKLM })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.equal(r.failed, 2);
  assert.ok(r.results.every((x) => /declined, so this was left as it is/.test(x.error)));
  assert.ok(fs.existsSync(path.join(w.pf, 'PuTTY')) && w.registry.has(HKLM));
  assert.equal(r.backupDir, null);
  assert.ok(!fs.existsSync(w.deps.backupRoot), 'not even the empty backups folder is left');
});

test('a prompt nobody answered in time is reported in plain words, not as a command dump', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.pf, 'SlowApp'));
  w.deps.runElevated = async () => { throw Object.assign(new Error('The Windows permission prompt was not answered in time, so this was left as it is. If the prompt is still showing, choose No.'), { code: 'TIMEOUT' }); };
  const r = await removeLeftovers(scanOf([item({ kind: 'folder', path: path.join(w.pf, 'SlowApp'), empty: true })]), ['0'], w.deps);
  assert.match(r.results[0].error, /not answered in time.*choose No/);
  assert.doesNotMatch(r.results[0].error, /administrator step failed/);
  assert.ok(fs.existsSync(path.join(w.pf, 'SlowApp')));
});

test('the administrator step is not taken on its word: if it says "done" but the item is still there, that is reported', async () => {
  const w = world();
  fs.mkdirSync(path.join(w.pf, 'PuTTY'));
  w.registry.set(HKLM, { subkeys: 0, values: 1 });
  w.deps.runElevated = fakeAdmin(w, { lie: true });
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.pf, 'PuTTY'), empty: true }), item({ kind: 'registry', path: HKLM })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.equal(r.removed, 0);
  assert.ok(r.results.every((x) => /still there/.test(x.error)));
});

test('a key that went without a backup file is reported as such, and the helper\'s own refusal is passed on', async () => {
  const w = world();
  w.registry.set(HKLM, { subkeys: 0, values: 1 });
  w.deps.runElevated = fakeAdmin(w, { skipBackup: true });
  const r = await removeLeftovers(scanOf([item({ kind: 'registry', path: HKLM })]), ['0'], w.deps);
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /backup file is missing/);

  const w2 = world();
  fs.mkdirSync(path.join(w2.pf, 'PuTTY'));
  w2.deps.runElevated = async (job) => job.items.map((i) => ({ id: i.id, ok: false, error: 'It is a link, which is never followed.' }));
  const r2 = await removeLeftovers(scanOf([item({ kind: 'folder', path: path.join(w2.pf, 'PuTTY'), empty: true })]), ['0'], w2.deps);
  assert.match(r2.results[0].error, /link/);
});

test('assessItem: what the window may offer, and what needs administrator rights', () => {
  const roots = { files: ['C:\\Users\\u\\AppData\\Roaming', 'C:\\Program Files', 'C:\\ProgramData'], registry: [] };
  const isAllUsers = (p) => /^C:\\Program( Files|Data)/i.test(p);
  const a = (over) => assessItem({ kind: 'folder', confidence: 'medium', empty: false, tooBig: false, ...over }, { roots, isAllUsers, ownKey: null });
  assert.deepEqual(a({ path: 'C:\\Users\\u\\AppData\\Roaming\\PuTTY' }), { allUsers: false, removable: true, whyNot: null });
  assert.deepEqual(a({ path: 'C:\\Program Files\\PuTTY', empty: true }), { allUsers: true, removable: true, whyNot: null });
  assert.match(a({ path: 'C:\\Program Files\\PuTTY', empty: false }).whyNot, /Show in folder/);
  assert.match(a({ kind: 'file', path: 'C:\\ProgramData\\PuTTY\\x.ini' }).whyNot, /Show in folder/);
  assert.match(a({ path: 'C:\\Users\\u\\AppData\\Roaming\\BigApp', tooBig: true }).whyNot, /2 GB/);
  assert.match(a({ path: 'C:\\Users\\u\\AppData\\Roaming\\Simon', confidence: 'low' }).whyNot, /other apps/);
  assert.equal(a({ path: 'C:\\Users\\u\\AppData\\Roaming\\Simon', confidence: 'low', empty: true }).removable, true);
  assert.match(a({ path: 'C:\\Program Files\\Common Files', empty: true }).whyNot, /Windows or shared/);
  assert.match(a({ path: 'C:\\Elsewhere\\PuTTY' }).whyNot, /outside/);
  const k = (over) => assessItem({ kind: 'registry', confidence: 'medium', empty: false, ...over }, { roots, isAllUsers, ownKey: null });
  assert.deepEqual(k({ path: HKLM }), { allUsers: true, removable: true, whyNot: null });
  assert.deepEqual(k({ path: KEY }), { allUsers: false, removable: true, whyNot: null });
  assert.equal(k({ path: HKLM, confidence: 'low' }).removable, false);
  assert.equal(k({ path: HKLM, confidence: 'low', empty: true }).removable, true);
  assert.equal(k({ path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' }).removable, false);
});

test('assessItem with the real classifier: Program Files and ProgramData count as all-users, so a non-empty folder there never goes to the Recycle Bin', () => {
  const roots = { files: [process.env.ProgramFiles, process.env.ProgramData], registry: [] };
  const a = (p, empty) => assessItem({ kind: 'folder', confidence: 'medium', empty, tooBig: false, path: p }, { roots });
  const full = a(path.join(process.env.ProgramFiles, 'WebaseXApp'), false);
  assert.equal(full.allUsers, true);
  assert.equal(full.removable, false);
  assert.match(full.whyNot, /Show in folder/);
  assert.deepEqual(a(path.join(process.env.ProgramData, 'WebaseXApp'), true), { allUsers: true, removable: true, whyNot: null });
});

// The real script of the administrator step, run WITHOUT elevation on throwaway folders. It is the code that will run with full rights,
// so its own refusals are tested here.
test('the real administrator script removes only an empty, real folder inside the given roots', async () => {
  const w = world();
  const resultFile = path.join(w.base, 'result.json');
  const mk = (...p) => { const d = path.join(w.pf, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const empty = mk('EmptyApp');
  const full = mk('FullApp');
  fs.writeFileSync(path.join(full, 'keep.txt'), 'x');
  const outside = mk('..', 'outside');
  const link = path.join(w.pf, 'LinkApp');
  fs.symlinkSync(outside, link, 'junction');
  const viaLink = path.join(link, 'Inner');
  fs.mkdirSync(path.join(outside, 'Inner'));
  const file = path.join(w.pf, 'a.txt');
  fs.writeFileSync(file, 'x');
  const items = [
    ['empty', empty],
    ['full', full],
    ['link', link],
    ['viaLink', viaLink],
    ['file', file],
    ['outsideRoot', path.join(w.base, 'appdata')],
    ['root', w.pf],
    ['dots', `${w.pf}\\EmptyApp\\..\\FullApp`], // path.join would tidy the ".." away
    ['gone', path.join(w.pf, 'NeverExisted')],
  ].map(([id, p]) => ({ id, kind: 'folder', path: p }));
  const res = await runElevated({ items, roots: [w.pf], ownKey: null, resultFile }, { elevate: false });
  const by = Object.fromEntries(res.map((x) => [x.id, x]));

  assert.equal(by.empty.ok, true);
  assert.ok(!fs.existsSync(empty));
  assert.equal(by.gone.ok, true, 'already gone counts as done');
  for (const id of ['full', 'link', 'viaLink', 'file', 'outsideRoot', 'root', 'dots']) assert.equal(by[id].ok, false, `${id} must be refused`);
  assert.match(by.full.error, /not empty/);
  assert.match(by.link.error, /link/);
  assert.match(by.viaLink.error, /link/);
  assert.match(by.file.error, /empty folder/);
  assert.match(by.outsideRoot.error, /outside/);
  assert.ok(fs.existsSync(path.join(full, 'keep.txt')) && fs.existsSync(path.join(outside, 'Inner')) && fs.existsSync(file));
  assert.ok(!fs.existsSync(resultFile), 'the result file is cleaned up');
});

test('a permission prompt answered after the app gave up does nothing; an oversized batch is refused before any prompt', async () => {
  const w = world();
  const late = path.join(w.pf, 'LateApp');
  fs.mkdirSync(late);
  await assert.rejects(
    () => runElevated({ items: [{ id: 'a', kind: 'folder', path: late }], roots: [w.pf], ownKey: null, resultFile: path.join(w.base, 'late.json'), notAfter: Date.now() - 1000 }, { elevate: false }),
    /did not report back/,
  );
  assert.ok(fs.existsSync(late), 'the late run removed nothing');

  const reg = (i) => ({ id: String(i), kind: 'registry', path: `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Some Vendor Name\\Some Application ${i}`, backup: `${w.base}\\backups\\2026-10-25T13-02-49-SomeProgramName\\${i}-Some-Vendor-Name-Some-Application-${i}.reg` });
  const many = (n, make) => ({ items: Array.from({ length: n }, (_, i) => make(i)), roots: [w.pf], ownKey: null, resultFile: path.join(w.base, 'big.json') });
  await assert.rejects(() => runElevated(many(51, (i) => ({ id: String(i), kind: 'folder', path: path.join(w.pf, `A${i}`) })), { elevate: true }), /Too many/);
  await assert.rejects(() => runElevated(many(40, reg), { elevate: true }), /Too many/, 'long registry items hit the command-line size limit first (about 18 fit)');
});

test('the real administrator script refuses registry keys outside app-level HKLM\\SOFTWARE keys', async () => {
  const w = world();
  const resultFile = path.join(w.base, 'result.json');
  const keys = [
    'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Foo',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Foo',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Foo',
    'HKEY_LOCAL_MACHINE\\SOFTWARE',
  ];
  const items = [...keys.map((p, i) => ({ id: `k${i}`, kind: 'registry', path: p, backup: path.join(w.base, `k${i}.reg`) })), { id: 'nope', kind: 'registry', path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WebaseNoSuchVendor\\Nothing', backup: path.join(w.base, 'nope.reg') }];
  const res = await runElevated({ items, roots: [], ownKey: null, resultFile }, { elevate: false });
  assert.deepEqual(res.slice(0, keys.length).map((x) => x.ok), keys.map(() => false));
  assert.equal(res.at(-1).ok, true, 'a key that does not exist counts as already gone');
  assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.endsWith('.reg')), [], 'nothing was exported');
});

test('a Recycle Bin move that never finishes is cut off with a clear message instead of hanging', async () => {
  const w = world();
  put(path.join(w.base, 'appdata', 'HangApp', 'f.txt'));
  w.deps.trashItem = () => new Promise(() => {}); // never settles
  w.deps.trashTimeoutMs = 50;
  const t = Date.now();
  const r = await removeLeftovers(scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'HangApp') })]), ['0'], w.deps);
  assert.ok(Date.now() - t < 3000, 'returned promptly');
  assert.match(r.results[0].error, /did not finish.*File Explorer/);
  assert.ok(fs.existsSync(path.join(w.base, 'appdata', 'HangApp', 'f.txt')));
});

test('only ids from the scan are accepted', async () => {
  const w = world();
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'PuTTY') })]);
  await assert.rejects(() => removeLeftovers(scan, ['7'], w.deps), /out of date/);
  await assert.rejects(() => removeLeftovers(scan, [], w.deps), /Nothing is selected/);
  await assert.rejects(() => removeLeftovers(scan, [0], w.deps), /Nothing is selected/);
  await assert.rejects(() => removeLeftovers(scan, Array(201).fill('0'), w.deps), /Nothing is selected/);
  assert.deepEqual(w.log, []);
});

test('publisher-level items are removed only when empty', async () => {
  const w = world();
  const pubKey = 'HKEY_CURRENT_USER\\Software\\SimonTatham';
  w.registry.set(pubKey, { subkeys: 1, values: 0 });
  put(path.join(w.base, 'appdata', 'Simon Tatham', 'OtherApp', 'data.txt'));
  fs.mkdirSync(path.join(w.base, 'local', 'SimonTatham'));
  const scan = scanOf([
    item({ kind: 'registry', path: pubKey, confidence: 'low' }),
    item({ kind: 'folder', path: path.join(w.base, 'appdata', 'Simon Tatham'), confidence: 'low' }),
    item({ kind: 'folder', path: path.join(w.base, 'local', 'SimonTatham'), confidence: 'low', empty: true }),
  ]);
  const r = await removeLeftovers(scan, ['0', '1', '2'], w.deps);
  const result = (p) => r.results.find((x) => x.path === p);
  assert.equal(result(pubKey).ok, false);
  assert.ok(w.registry.has(pubKey), 'the non-empty publisher key stays');
  assert.equal(result(path.join(w.base, 'appdata', 'Simon Tatham')).ok, false);
  assert.ok(fs.existsSync(path.join(w.base, 'appdata', 'Simon Tatham', 'OtherApp', 'data.txt')));
  assert.equal(r.results.filter((x) => x.ok).length, 1, 'only the empty publisher folder was removed');
  assert.ok(!fs.existsSync(path.join(w.base, 'local', 'SimonTatham')));
  assert.ok(!w.log.some((l) => l.includes(pubKey)), 'a non-empty publisher key is not even exported or deleted');
});

test('a key and the key above it can be removed together, deepest first', async () => {
  const w = world();
  w.registry.set('HKEY_CURRENT_USER\\Software\\SimonTatham', { subkeys: 1, values: 0 });
  w.registry.set(KEY, { subkeys: 1, values: 0 });
  w.registry.set(`${KEY}\\Sessions`, { subkeys: 0, values: 1 });
  const scan = scanOf([
    item({ kind: 'registry', path: 'HKEY_CURRENT_USER\\Software\\SimonTatham', confidence: 'low', empty: true }),
    item({ kind: 'registry', path: KEY }),
  ]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.equal(r.removed, 2);
  assert.deepEqual(w.log.filter((l) => l.startsWith('delete')), [`delete ${KEY}`, 'delete HKEY_CURRENT_USER\\Software\\SimonTatham']);
});

test('a link is never followed or removed, and neither is a folder that contains one', async () => {
  const w = world();
  const outside = path.join(w.base, 'outside');
  put(path.join(outside, 'precious.txt'));
  fs.symlinkSync(outside, path.join(w.base, 'appdata', 'PuTTY'), 'junction');
  fs.mkdirSync(path.join(w.base, 'local', 'PuTTY'));
  fs.symlinkSync(outside, path.join(w.base, 'local', 'PuTTY', 'inner'), 'junction');
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'PuTTY') }), item({ kind: 'folder', path: path.join(w.base, 'local', 'PuTTY') })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.equal(r.failed, 2);
  assert.match(r.results[0].error + r.results[1].error, /link/);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  assert.deepEqual(w.log, []);
});

test('a path outside the handled folders is refused even if it is in the scan', async () => {
  const w = world();
  put(path.join(w.base, 'elsewhere', 'PuTTY', 'x.txt'));
  put(path.join(w.base, 'appdata', 'x', 'y.txt'));
  const scan = scanOf([
    item({ kind: 'folder', path: path.join(w.base, 'elsewhere', 'PuTTY') }),
    item({ kind: 'folder', path: path.join(w.base, 'appdata', '..', 'elsewhere', 'PuTTY') }),
    item({ kind: 'folder', path: w.roots.files[0] }),
  ]);
  const r = await removeLeftovers(scan, ['0', '1', '2'], w.deps);
  assert.equal(r.failed, 3);
  assert.ok(fs.existsSync(path.join(w.base, 'elsewhere', 'PuTTY', 'x.txt')));
  assert.deepEqual(w.log, []);
});

test('something already gone counts as removed, and a failed move to the Recycle Bin is reported', async () => {
  const w = world();
  put(path.join(w.base, 'appdata', 'Stubborn', 'f.txt'));
  w.deps.trashItem = async () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
  const scan = scanOf([item({ kind: 'folder', path: path.join(w.base, 'appdata', 'Gone') }), item({ kind: 'folder', path: path.join(w.base, 'appdata', 'Stubborn') })]);
  const r = await removeLeftovers(scan, ['0', '1'], w.deps);
  assert.equal(r.results.find((x) => x.path.endsWith('Gone')).ok, true);
  assert.match(r.results.find((x) => x.path.endsWith('Stubborn')).error, /administrator/);
  assert.ok(fs.existsSync(path.join(w.base, 'appdata', 'Stubborn', 'f.txt')));
});

test('registry rules: only app-level Software keys; the app\'s own uninstall entry only when it is the one that was scanned', () => {
  for (const ok of [KEY, 'HKEY_CURRENT_USER\\Software\\SimonTatham', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\SimonTatham\\PuTTY64', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\SimonTatham']) assert.equal(whyRegistryRefused(ok, null), null, ok);
  for (const bad of ['HKEY_CURRENT_USER\\Software', 'HKEY_CURRENT_USER\\Software\\', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Foo', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\Foo', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\X', 'HKEY_USERS\\S-1\\Software\\Foo', 'HKEY_CURRENT_USER\\Software\\Ab', 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Foo']) assert.ok(whyRegistryRefused(bad, null), `should refuse ${bad}`);
  const own = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ABC}';
  assert.equal(whyRegistryRefused(own, own), null);
  assert.ok(whyRegistryRefused(own, null));
  assert.ok(whyRegistryRefused('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OTHER}', own));
});

test('file rules: only app-level folders strictly inside the known roots', () => {
  const roots = { files: ['C:\\Users\\u\\AppData\\Roaming', 'C:\\Users\\u\\AppData\\Local', 'C:\\Users\\u\\AppData\\Local\\Programs', 'C:\\Program Files', 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'], registry: [] };
  for (const ok of ['C:\\Users\\u\\AppData\\Roaming\\PuTTY', 'C:\\Users\\u\\AppData\\Roaming\\Simon Tatham\\PuTTY', 'C:\\Users\\u\\AppData\\Local\\Programs\\SomeApp', 'C:\\Program Files\\PuTTY', 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\PuTTY (64-bit)']) assert.equal(whyFileRefused(ok, roots), null, ok);
  for (const bad of ['C:\\Users\\u\\AppData\\Roaming', 'C:\\Program Files', 'C:\\Users\\u\\AppData\\Local\\Programs', 'C:\\Windows\\System32\\drivers', 'C:\\Users\\u\\Documents\\PuTTY', 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows', 'C:\\Users\\u\\AppData\\Roaming\\..\\..\\Documents', 'C:\\Program Files\\Ab', 'D:\\PuTTY']) assert.ok(whyFileRefused(bad, roots), `should refuse ${bad}`);
});
