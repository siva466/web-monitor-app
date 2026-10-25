const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { listBackups, restoreKey, restoreFolder, deleteBackup, backupDir, pickBinEntry, compareRestored, RESTORE_SCRIPT } = require('./backups');
const { runScript } = require('./leftover-admin');
const { isAdmin } = require('./cleanup');

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));

const KEY = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY';
const HKLM = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\SimonTatham\\PuTTY64';
const reg = (...lines) => ['Windows Registry Editor Version 5.00', '', ...lines, ''].join('\r\n');
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const GOOD = (key) => reg(`[${key}]`, '"HostName"="example.org"', '"Port"=dword:00000016', `[${key}\\Sessions]`, '@="x"');
const WHEN = '2026-10-25T13:17:12.000Z';

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-bak-test-'));
  bases.push(base);
  const root = path.join(base, 'backups');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'appdata'));
  const calls = { import: [], undelete: [], run: [] };
  const live = { keys: new Map(), bin: [] }; // what "Windows" holds in these tests
  const deps = {
    backupRoot: root,
    tmpDir: base,
    roots: { files: [path.join(base, 'appdata')], registry: [] },
    now: Date.parse(WHEN),
    keysNow: async (keys) => keys.filter((k) => live.keys.has(k)).map((k) => ({ key: k, subkeys: 1, values: live.keys.get(k) })),
    readBin: async (names) => live.bin.filter((b) => names.includes(b.name)),
    undelete: async (binPath) => { calls.undelete.push(binPath); const e = live.bin.find((b) => b.binPath === binPath); if (e && e.restoreTo) fs.mkdirSync(e.restoreTo, { recursive: true }); return e ? 'DONE' : 'NOTFOUND'; },
    importKey: async (file) => { calls.import.push(fs.readFileSync(file)); },
    readBack: async (keys) => keys.map((k) => ({ key: k, exists: true, values: [{ name: 'HostName', kind: 'String', data: 'example.org' }, { name: 'Port', kind: 'DWord', data: 22 }, { name: '', kind: 'String', data: 'x' }] })),
    run: async (script, job, opts) => { calls.run.push({ script, job, opts }); return { status: 'restored' }; },
  };
  const backup = (id, manifest, files = {}) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    if (manifest !== null) fs.writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
  };
  return { base, root, deps, calls, live, backup };
}
const ID_A = '2026-10-25T13-17-12-PuTTY-release-0-85';
const ID_B = '2026-10-24T09-00-00-OldApp';

test('the list shows newest first, with each item, whether it can be restored, and what is true now', async () => {
  const w = world();
  const folder = path.join(w.base, 'appdata', 'PuTTY');
  const adminFolder = path.join(process.env.ProgramFiles, 'WebaseNoSuchApp');
  w.backup(ID_A, { format: 2, when: WHEN, app: 'PuTTY', publisher: 'Simon Tatham', results: [
    { path: KEY, kind: 'registry', ok: true, method: 'reg-export', backupFile: '01-key.reg' },
    { path: folder, kind: 'folder', ok: true, method: 'recycle-bin' },
    { path: adminFolder, kind: 'folder', ok: true, method: 'admin-empty-folder' },
    { path: `${KEY}2`, kind: 'registry', ok: false, error: 'nope' },
  ] }, { '01-key.reg': utf16(GOOD(KEY)) });
  // an older backup: no method, no file name; the file is found by its key line, the folder kind is guessed from where it was
  w.backup(ID_B, { when: '2026-10-24T09:00:00.000Z', app: 'OldApp', results: [
    { path: KEY, kind: 'registry', ok: true },
    { path: adminFolder, kind: 'folder', ok: true },
  ] }, { '99-anything.reg': utf16(GOOD(KEY)) });
  w.backup('2026-10-23T08-00-00-Broken', '{ not json');
  fs.mkdirSync(path.join(w.root, 'not-a-backup'));
  w.live.keys.set(KEY, 3);
  w.live.bin.push({ name: 'PuTTY', from: path.join(w.base, 'appdata'), deleted: '2026-10-25T13:17:13.000Z', isFolder: true, binPath: 'C:\\$Recycle.Bin\\S-1\\$R1' });

  const { backups } = await listBackups(w.deps);
  assert.deepEqual(backups.map((b) => b.id), [ID_A, ID_B, '2026-10-23T08-00-00-Broken']);
  const [a, b, broken] = backups;
  assert.deepEqual([a.app, a.publisher, a.readable], ['PuTTY', 'Simon Tatham', true]);
  assert.equal(a.items.length, 3, 'a failed removal is not listed: nothing was removed');
  const [k, f, e] = a.items;
  assert.deepEqual([k.kind, k.canRestore, k.how], ['registry', true, 'reg-export']);
  assert.match(k.state, /exists now \(3 values/);
  assert.deepEqual([f.how, f.canRestore, f.state], ['recycle-bin', true, 'In the Recycle Bin.']);
  assert.deepEqual([e.how, e.canRestore, e.state], ['admin-empty-folder', false, 'Held nothing.']);
  assert.equal(b.items[0].canRestore, true, 'the old backup is still restorable: its file was found by the key line');
  assert.equal(b.items[1].how, 'admin-empty-folder', 'an old manifest: a folder in Program Files was an empty all-users folder');
  assert.deepEqual([broken.readable, broken.items.length], [false, 0]);
});

test('folder states: gone from the bin, back in place, ambiguous; a missing registry key says so', async () => {
  const w = world();
  const folder = path.join(w.base, 'appdata', 'Gone');
  const back = path.join(w.base, 'appdata', 'Back');
  fs.mkdirSync(back);
  w.backup(ID_A, { format: 2, when: WHEN, app: 'X', results: [
    { path: folder, kind: 'folder', ok: true, method: 'recycle-bin' },
    { path: back, kind: 'folder', ok: true, method: 'recycle-bin' },
    { path: KEY, kind: 'registry', ok: true, method: 'reg-export', backupFile: 'k.reg' },
  ] }, { 'k.reg': utf16(GOOD(KEY)) });
  const { backups } = await listBackups(w.deps);
  const [g, b, k] = backups[0].items;
  assert.deepEqual([g.canRestore, g.state], [false, 'No longer in the Recycle Bin.']);
  assert.deepEqual([b.canRestore, b.state], [false, 'A folder with this name exists again, so it is not put back.']);
  assert.equal(k.state, 'The key is gone.');
});

test('a backup file that would do more than restore (delete, other keys, too big, missing) is listed but cannot be restored', async () => {
  const w = world();
  w.backup(ID_A, { format: 2, when: WHEN, app: 'X', results: ['a', 'b', 'c', 'd'].map((n, i) => ({ path: `${KEY}${i}`, kind: 'registry', ok: true, method: 'reg-export', backupFile: `${n}.reg` })) }, {
    'a.reg': utf16(reg(`[${KEY}0]`, '"x"="1"', `[-${KEY}0\\Sub]`)),
    'b.reg': utf16(reg(`[${KEY}1]`, '"x"="1"', '[HKEY_CURRENT_USER\\Software\\Other]', '"y"="2"')),
    'c.reg': utf16(reg(`[${KEY}2]`, `"x"="${'q'.repeat(40000)}"`)),
  });
  const { backups } = await listBackups(w.deps);
  const [a, b, c, d] = backups[0].items;
  assert.match(a.why, /delete a key/);
  assert.match(b.why, /other than the one/);
  assert.match(c.why, /too big/);
  assert.match(d.why, /missing/);
  assert.ok([a, b, c, d].every((i) => !i.canRestore));
});

test('restoring a current-user key imports the original bytes unchanged and checks the values afterwards', async () => {
  const w = world();
  const original = utf16(GOOD(KEY));
  w.backup(ID_A, { format: 2, when: WHEN, app: 'PuTTY', results: [{ path: KEY, kind: 'registry', ok: true, method: 'reg-export', backupFile: '01-key.reg' }] }, { '01-key.reg': original });
  const r = await restoreKey(ID_A, 0, w.deps);
  assert.equal(r.status, 'restored');
  assert.match(r.message, /Restored 2 keys and 3 values/);
  assert.equal(w.calls.import.length, 1);
  assert.deepEqual(w.calls.import[0], original, 'the file that was imported is the backup, byte for byte');
  assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.startsWith('webase-restore')), [], 'the temporary copy is deleted');
  assert.equal(w.calls.run.length, 0, 'no administrator step for a current-user key');
});

test('"the key exists" is not enough: a value that did not come back, or has other data, is reported', async () => {
  const w = world();
  w.backup(ID_A, { format: 2, when: WHEN, app: 'X', results: [{ path: KEY, kind: 'registry', ok: true, method: 'reg-export', backupFile: 'k.reg' }] }, { 'k.reg': utf16(GOOD(KEY)) });
  w.deps.readBack = async (keys) => keys.map((k) => ({ key: k, exists: true, values: [{ name: 'HostName', kind: 'String', data: 'something else' }] }));
  const r = await restoreKey(ID_A, 0, w.deps);
  assert.equal(r.status, 'partial');
  assert.match(r.message, /value PuTTY: HostName is different/);
  assert.match(r.message, /value PuTTY: Port is missing/);
  w.deps.readBack = async (keys) => keys.map((k) => ({ key: k, exists: false, values: [] }));
  assert.match((await restoreKey(ID_A, 0, w.deps)).message, /key PuTTY is missing/);
});

test('a tampered backup is refused before anything is imported', async () => {
  const w = world();
  w.backup(ID_A, { format: 2, when: WHEN, app: 'X', results: [{ path: KEY, kind: 'registry', ok: true, method: 'reg-export', backupFile: 'k.reg' }] }, { 'k.reg': utf16(GOOD(KEY) + `[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]\r\n"x"="calc.exe"\r\n`) });
  await assert.rejects(() => restoreKey(ID_A, 0, w.deps), /other than the one that was backed up/);
  assert.equal(w.calls.import.length + w.calls.run.length, 0);
});

test('only ids and items this app made are accepted: no paths, no traversal, no folders as keys, no keys as folders', async () => {
  const w = world();
  const folder = path.join(w.base, 'appdata', 'PuTTY');
  w.backup(ID_A, { format: 2, when: WHEN, app: 'X', results: [{ path: KEY, kind: 'registry', ok: true, method: 'reg-export', backupFile: '..\\..\\evil.reg' }, { path: folder, kind: 'folder', ok: true, method: 'recycle-bin' }, { path: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Foo', kind: 'registry', ok: true, backupFile: 'z.reg' }] }, { 'z.reg': utf16(GOOD('HKEY_CURRENT_USER\\Software\\Microsoft\\Foo')) });
  for (const bad of ['..', '..\\x', 'C:\\Windows', `${ID_A}\\..`, `${ID_A}/..`, '', null, 7, 'not-a-backup']) await assert.rejects(() => restoreKey(bad, 0, w.deps), /not a backup this app made|not there/, String(bad));
  await assert.rejects(() => restoreKey(ID_A, 9, w.deps), /not in this backup/);
  await assert.rejects(() => restoreKey(ID_A, 'x', w.deps), /not in this backup/);
  await assert.rejects(() => restoreKey(ID_A, 1, w.deps), /not in this backup/, 'a folder item is not a key');
  await assert.rejects(() => restoreFolder(ID_A, 0, w.deps), /not in this backup/, 'a key item is not a folder');
  await assert.rejects(() => restoreKey(ID_A, 0, w.deps), /missing/, 'a file name with a path in it is never used');
  await assert.rejects(() => restoreKey(ID_A, 2, w.deps), /Windows or shared/, 'the same name rules as removal apply');
});

test('an all-users key goes through the administrator step as validated text inside the request, never as a path', async () => {
  const w = world();
  const text = GOOD(HKLM);
  w.backup(ID_A, { format: 2, when: WHEN, app: 'PuTTY', results: [{ path: HKLM, kind: 'registry', ok: true, method: 'reg-export', backupFile: 'h.reg' }] }, { 'h.reg': utf16(text) });
  const r = await restoreKey(ID_A, 0, w.deps);
  assert.equal(r.status, 'restored');
  assert.equal(w.calls.import.length, 0, 'not imported from this process');
  const { script, job, opts } = w.calls.run[0];
  assert.equal(script, RESTORE_SCRIPT);
  assert.equal(job.mode, 'restore');
  assert.equal(job.key, HKLM);
  assert.equal(zlib.gunzipSync(Buffer.from(job.reg, 'base64')).toString('utf8'), text, 'the text that was validated is the text that is sent');
  assert.ok(!('file' in job) && !('path' in job));
  assert.equal(opts.deadlineMs, 3 * 60 * 1000);

  w.deps.run = async () => { throw Object.assign(new Error('x'), { code: 'DECLINED' }); };
  assert.deepEqual(await restoreKey(ID_A, 0, w.deps), { status: 'declined', message: 'The Windows permission prompt was declined, so nothing changed.' });
  w.deps.run = async () => { throw Object.assign(new Error('not answered in time'), { code: 'TIMEOUT' }); };
  assert.equal((await restoreKey(ID_A, 0, w.deps)).status, 'not-answered');
  w.deps.run = async () => ({ status: 'refused', message: 'The file touches a key other than the one that was backed up.' });
  assert.match((await restoreKey(ID_A, 0, w.deps)).message, /other than the one/);
});

test('putting a folder back: the entry deleted nearest to the removal is taken; two equal candidates are refused; nothing is guessed', () => {
  const from = 'C:\\Users\\u\\AppData\\Roaming';
  const p = `${from}\\PuTTY`;
  const e = (deleted, binPath, over = {}) => ({ name: 'PuTTY', from, deleted, isFolder: true, binPath, ...over });
  const when = Date.parse(WHEN);
  assert.equal(pickBinEntry([e('2026-10-25T13:17:13.000Z', 'A')], p, when).entry.binPath, 'A');
  assert.equal(pickBinEntry([e('2026-10-25T13:17:13.000Z', 'A')], p, null).entry.binPath, 'A', 'one candidate is enough even with no time');
  assert.equal(pickBinEntry([e('2026-10-25T10:00:00.000Z', 'OLD'), e('2026-10-25T13:17:14.000Z', 'NEW')], p, when).entry.binPath, 'NEW', 'an earlier test copy of the same name is not taken');
  assert.equal(pickBinEntry([e('2026-10-25T13:17:13.000Z', 'A'), e('2026-10-25T13:17:13.500Z', 'B')], p, when).ambiguous, true, 'two entries from the same moment: ask the person');
  assert.equal(pickBinEntry([e('2026-10-20T10:00:00.000Z', 'A'), e('2026-10-21T10:00:00.000Z', 'B')], p, when).ambiguous, true, 'none close to the removal');
  assert.equal(pickBinEntry([e('x', 'F', { isFolder: false }), e('x', 'G', { from: 'C:\\Other' })], p, when).entry, null);
  assert.equal(pickBinEntry([e('2026-10-25T13:17:13.000Z', 'A', { name: 'putty', from: from.toLowerCase() })], p, when).entry.binPath, 'A', 'case does not matter');
});

test('restoring a folder uses the Recycle Bin entry, checks the folder is back, and refuses the cases that are not safe', async () => {
  const w = world();
  const folder = path.join(w.base, 'appdata', 'PuTTY');
  w.backup(ID_A, { format: 2, when: WHEN, app: 'PuTTY', results: [{ path: folder, kind: 'folder', ok: true, method: 'recycle-bin' }, { path: path.join(process.env.ProgramFiles, 'WebaseNoSuchApp'), kind: 'folder', ok: true, method: 'admin-empty-folder' }] });
  w.live.bin.push({ name: 'PuTTY', from: path.join(w.base, 'appdata'), deleted: '2026-10-25T13:17:13.000Z', isFolder: true, binPath: 'BIN1', restoreTo: folder });
  assert.deepEqual(await restoreFolder(ID_A, 0, w.deps), { status: 'restored', message: 'The folder is back where it was.' });
  assert.deepEqual(w.calls.undelete, ['BIN1']);
  await assert.rejects(() => restoreFolder(ID_A, 0, w.deps), /exists again/, 'it is back now: a second restore is refused');
  await assert.rejects(() => restoreFolder(ID_A, 1, w.deps), /empty, so there is nothing/);

  fs.rmSync(folder, { recursive: true });
  w.live.bin.length = 0;
  await assert.rejects(() => restoreFolder(ID_A, 0, w.deps), /no longer in the Recycle Bin/);
  w.live.bin.push({ name: 'PuTTY', from: path.join(w.base, 'appdata'), deleted: '2026-10-25T13:17:13.000Z', isFolder: true, binPath: 'BIN2' }); // restore does nothing
  assert.equal((await restoreFolder(ID_A, 0, w.deps)).status, 'failed');
  w.live.bin.push({ name: 'PuTTY', from: path.join(w.base, 'appdata'), deleted: '2026-10-25T13:17:13.400Z', isFolder: true, binPath: 'BIN3' });
  await assert.rejects(() => restoreFolder(ID_A, 0, w.deps), /Several entries/);
});

test('a removed FILE is listed and put back like a folder; the Recycle Bin may list it without its extension', async () => {
  const w = world();
  const file = path.join(w.base, 'appdata', 'WebaseNote.ini');
  w.backup(ID_A, { format: 2, when: WHEN, app: 'Note', results: [{ path: file, kind: 'file', ok: true, method: 'recycle-bin' }] });
  w.live.bin.push({ name: 'WebaseNote', from: path.join(w.base, 'appdata'), deleted: '2026-10-25T13:17:13.000Z', isFolder: false, binPath: 'FILEBIN', restoreTo: null });
  const { backups } = await listBackups(w.deps);
  const [item] = backups[0].items;
  assert.deepEqual([item.kind, item.how, item.canRestore, item.state], ['file', 'recycle-bin', true, 'In the Recycle Bin.']);

  // the bin lookup asks for both spellings of the name
  let asked = [];
  w.deps.readBin = async (names) => { asked = names; return w.live.bin; };
  w.deps.undelete = async (binPath) => { w.calls.undelete.push(binPath); fs.writeFileSync(file, 'back'); return 'DONE'; };
  assert.deepEqual(await restoreFolder(ID_A, 0, w.deps), { status: 'restored', message: 'The file is back where it was.' });
  assert.deepEqual(asked.sort(), ['WebaseNote', 'WebaseNote.ini']);
  assert.deepEqual(w.calls.undelete, ['FILEBIN']);
  await assert.rejects(() => restoreFolder(ID_A, 0, w.deps), /A file with this name exists again/);

  // a FOLDER entry with the same name is not taken for the file, and a file entry is not taken for a folder
  fs.rmSync(file);
  w.live.bin.length = 0;
  w.live.bin.push({ name: 'WebaseNote', from: path.join(w.base, 'appdata'), deleted: '2026-10-25T13:17:13.000Z', isFolder: true, binPath: 'FOLDERBIN' });
  await assert.rejects(() => restoreFolder(ID_A, 0, w.deps), /no longer in the Recycle Bin/);
  assert.equal(pickBinEntry([{ name: 'WebaseNote.ini', from: path.join(w.base, 'appdata'), deleted: null, isFolder: false, binPath: 'B' }], file, null, 'file').entry.binPath, 'B', 'the full name matches too');
  assert.equal(pickBinEntry([{ name: 'WebaseNote.ini', from: path.join(w.base, 'appdata'), deleted: null, isFolder: false, binPath: 'B' }], file, null, 'folder').entry, null);
});

test('deleting a backup removes that one folder; an unknown id, a link or a folder inside it stop it', async () => {
  const w = world();
  const dir = w.backup(ID_A, { format: 2, when: WHEN, app: 'X', results: [] }, { 'k.reg': utf16(GOOD(KEY)) });
  const keep = w.backup(ID_B, { when: WHEN, app: 'Y', results: [] });
  assert.deepEqual(await deleteBackup(ID_A, w.deps), { deleted: true });
  assert.ok(!fs.existsSync(dir) && fs.existsSync(keep), 'only the named backup went');
  await assert.rejects(() => deleteBackup('..', w.deps), /not a backup/);
  await assert.rejects(() => deleteBackup(ID_A, w.deps), /not there any more/);

  const odd = w.backup('2026-10-22T07-00-00-Odd', { when: WHEN, app: 'Z', results: [] });
  const outside = path.join(w.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'x');
  fs.symlinkSync(outside, path.join(odd, 'link'), 'junction');
  await assert.rejects(() => deleteBackup('2026-10-22T07-00-00-Odd', w.deps), /unexpected/);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')) && fs.existsSync(odd), 'nothing was deleted, and the link target is intact');

  const linked = path.join(w.root, '2026-10-21T07-00-00-Linked');
  fs.symlinkSync(outside, linked, 'junction');
  await assert.rejects(() => backupDir('2026-10-21T07-00-00-Linked', w.deps), /not a backup/);
  assert.ok(!(await listBackups(w.deps)).backups.some((b) => b.id.endsWith('Linked')), 'a link in the backup folder is not listed');
});

test('comparison of what a restore wrote: names are compared without case, data for strings and numbers', () => {
  const v = [{ key: 'K', name: 'Host', type: 'sz', data: 'a' }, { key: 'K', name: '', type: 'sz', data: 'd' }, { key: 'K', name: 'N', type: 'dword', data: 5 }, { key: 'K', name: 'B', type: 'hex', data: null }];
  const now = [{ key: 'k', exists: true, values: [{ name: 'HOST', kind: 'String', data: 'a' }, { name: '', kind: 'String', data: 'd' }, { name: 'n', kind: 'DWord', data: 5 }, { name: 'b', kind: 'Binary', data: null }] }];
  assert.deepEqual(compareRestored(v, now), { missing: [], wrong: [], keysMissing: [] });
  now[0].values[0].data = 'other';
  now[0].values.pop();
  assert.deepEqual(compareRestored(v, now), { missing: ['K: B'], wrong: ['K: Host'], keysMissing: [] });
});

// The two read-only system scripts, run for real. Found live: `@($json | ConvertFrom-Json)` nests the array in Windows PowerShell 5.1, so a
// lookup by name silently found nothing while every stand-in test passed. These run the exact lines the app runs.
const { BIN_LIST_SCRIPT, READ_SCRIPT, defaults } = require('./backups');
const { execFileSync } = require('child_process');
const psOut = (script, env) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true }).trim();

test('the names and keys sent to the system scripts arrive as a real list, for one item and for many', () => {
  for (const [script, env, v] of [[BIN_LIST_SCRIPT, 'WB_NAMES', 'names'], [READ_SCRIPT, 'WB_KEYS', 'keys']]) {
    const lines = script.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`$${v} = $env:`));
    assert.ok(at >= 0, `${env}: the line that reads the list is there`);
    const snippet = lines.slice(at, at + 2).join('\n'); // the line that reads the list and the one that makes sure it is a list
    const probe = (list) => psOut(`${snippet}\n"$($${v}.Count)|$($${v}[0])|$($${v} -contains '${list[0]}')"`, { [env]: JSON.stringify(list) });
    assert.equal(probe(['alpha']), '1|alpha|True', `${env}: one item`);
    assert.equal(probe(['alpha', 'beta']), '2|alpha|True', `${env}: two items`);
  }
});

test('reading keys really works: two keys that always exist come back with their values, and a missing one says so', async () => {
  const keys = ['HKEY_CURRENT_USER\\Software\\Microsoft', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft', 'HKEY_CURRENT_USER\\Software\\WebaseNoSuchKeyAnywhere'];
  const now = await defaults().readBack(keys);
  assert.deepEqual(now.map((k) => [k.key, k.exists]), [[keys[0], true], [keys[1], true], [keys[2], false]]);
  assert.ok(Array.isArray(now[0].values));
  assert.deepEqual((await defaults().readBack([keys[2]])).map((k) => k.exists), [false], 'a single key works too');
  assert.deepEqual(await defaults().readBin(['WebaseNoSuchFolderInTheRecycleBin']), [], 'the Recycle Bin lookup runs and finds nothing for an unknown name');
});

// The real administrator script, run WITHOUT elevation. It must stop at its own checks; a valid request reaches the import and is
// refused by Windows there (a normal user cannot write to HKLM), which also proves the request was decoded and checked.
const job = (key, text, over = {}) => ({ mode: 'restore', key, reg: zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64'), resultFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webase-rs-test-')), 'r.json'), ...over });
const run = (j) => runScript(RESTORE_SCRIPT, j, { elevate: false });

test('the real restore script refuses what it should', async (t) => {
  if (await isAdmin()) return t.skip('this test must not import into the real registry');
  const H = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WebaseRestoreTestNoSuchVendor';
  const refused = async (key, text, pattern) => { const r = await run(job(key, text)); assert.equal(r.status, 'refused', `${key}: ${r.message}`); assert.match(r.message, pattern); };
  await refused('HKEY_CURRENT_USER\\Software\\Vendor', GOOD('HKEY_CURRENT_USER\\Software\\Vendor'), /not a key this step restores/);
  await refused('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Foo', GOOD('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Foo'), /Windows or shared/);
  await refused('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Foo', GOOD('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Foo'), /not a key this step restores/);
  await refused(H, reg(`[${H}]`, '"a"="b"', `[-${H}\\Sub]`), /delete a key/);
  await refused(H, reg(`[${H}]`, '"a"="b"', '[HKEY_LOCAL_MACHINE\\SYSTEM\\Foo]', '"x"="y"'), /other than the one/);
  await refused(H, reg(`[${H}]`, '"a"=-'), /not in a form/);
  await refused(H, reg(`[${H}Evil]`, '"a"="b"'), /other than the one/);
  await refused(H, reg(`[${H}\\Sub]`, '"a"="b"'), /does not contain the key it is for/);
  await refused(H, ['REGEDIT4', '', `[${H}]`].join('\r\n'), /not a registry export/);
  await refused(H, reg(`[${H}]`, '"a"="x\\', `[-${H}]"`), /not in a form|delete a key/);

  const ok = await run(job(H, GOOD(H)));
  // a valid request passes every check; a normal user then cannot write the temporary file or the registry, which is the only way it can fail
  assert.equal(ok.status, 'failed', ok.message);
  // reg.exe must have been able to OPEN the file (found live: an open write handle gave "Error opening the file") and was then refused the registry
  assert.match(ok.message, /could not import it\. .*accessing the registry/i, ok.message);
  assert.doesNotMatch(ok.message, /opening the file|being used by another process/i);

  const garbage = await run(job(H, 'x', { reg: Buffer.from('not gzip').toString('base64') }));
  assert.equal(garbage.status, 'failed');
  await assert.rejects(() => run(job(H, GOOD(H), { notAfter: Date.now() - 1000 })), /did not report back/);
});
