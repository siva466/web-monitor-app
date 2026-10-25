const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const disk = require('./disk');

test.beforeEach(() => disk._reset());

const ENV = { USERPROFILE: 'C:\\Users\\u', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' };
const DISKS = [{ letter: 'C', used: 100, size: 475 }, { letter: 'D', used: 54, size: 931 }];
const row = (name, kind, bytes, over = {}) => ({ name, kind, bytes, files: kind === 'file' ? 1 : 3, denied: 0, partial: false, ...over });
const list = (rows, over = {}) => async (p) => ({ total: rows.reduce((n, r) => n + r.bytes, 0), rows, rest: null, links: 0, denied: 0, partial: false, ...over, _asked: p });
const deps = (listFn, over = {}) => ({ env: ENV, disks: async () => DISKS, list: listFn, ...over });

test('the named starting places are your user folder, Program Files, Program Files (x86), ProgramData and each fixed drive', async () => {
  assert.deepEqual((await disk.startList(deps(list([])))).map((s) => s.key), ['profile', 'pf', 'pf86', 'pdata', 'drive:C', 'drive:D']);
  assert.deepEqual(await disk.drives(deps(list([]))), [{ letter: 'C', used: 100, size: 475, free: 375 }, { letter: 'D', used: 54, size: 931, free: 877 }]);
});

test('a listing gives every row an id (links none), the share of the folder, and resolves ids back to paths in main only', async () => {
  let asked;
  const r = await disk.scanStart('profile', deps(async (p) => { asked = p; return list([row('Downloads', 'folder', 600), row('note.txt', 'file', 300), row('portal', 'link', 0, { files: 0 }), row('Empty', 'folder', 100)])(p); }));
  assert.equal(asked, path.resolve('C:\\Users\\u'));
  assert.deepEqual(r.rows.map((x) => [x.name, x.kind, x.bytes]), [['Downloads', 'folder', 600], ['note.txt', 'file', 300], ['portal', 'link', 0], ['Empty', 'folder', 100]]);
  assert.equal(r.total, 1000);
  assert.deepEqual(r.rows.map((x) => x.share), [0.6, 0.3, 0, 0.1]);
  assert.equal(r.rows[2].id, null, 'a link cannot be opened');
  assert.ok(r.rows.filter((x) => x.id).every((x) => /^\d+$/.test(x.id)));
  assert.equal(disk.resolve(r.rows[0].id), path.join(path.resolve('C:\\Users\\u'), 'Downloads'));
  assert.equal(disk.resolve(r.rows[1].id), path.join(path.resolve('C:\\Users\\u'), 'note.txt'));
  assert.deepEqual(r.trail.map((t) => t.label), ['Your user folder']);
  assert.equal(r.notCounted, null, 'only a whole drive has a "not counted" figure');
});

test('going deeper names an id; the path is rebuilt in main; breadcrumbs lead back; a file or an unknown id is refused', async () => {
  const seen = [];
  const l = (rows) => async (p) => { seen.push(p); return list(rows)(p); };
  const top = await disk.scanStart('pf', deps(l([row('Git', 'folder', 500), row('readme.txt', 'file', 5)])));
  const inGit = await disk.scanChild(top.rows[0].id, deps(l([row('bin', 'folder', 300)])));
  assert.equal(seen.at(-1), path.join(path.resolve('C:\\Program Files'), 'Git'));
  assert.deepEqual(inGit.trail.map((t) => t.label), ['Program Files', 'Git']);
  const deeper = await disk.scanChild(inGit.rows[0].id, deps(l([row('x.dll', 'file', 1)])));
  assert.equal(seen.at(-1), path.join(path.resolve('C:\\Program Files'), 'Git', 'bin'));
  assert.deepEqual(deeper.trail.map((t) => t.label), ['Program Files', 'Git', 'bin']);
  assert.equal(deeper.trail[0].id, top.id, 'the first breadcrumb leads back to the start');
  const back = await disk.scanChild(top.id, deps(l([row('Git', 'folder', 500)])));
  assert.equal(seen.at(-1), path.resolve('C:\\Program Files'));
  assert.equal(back.trail.length, 1);

  for (const bad of [top.rows[1].id, '999999', '', null, undefined, 7, '..\\..']) await assert.rejects(() => disk.scanChild(bad, deps(l([]))), /not in the latest listing/, String(bad));
  await assert.rejects(() => disk.scanStart('C:\\Windows', deps(l([]))), /not a place this page can look at/);
  await assert.rejects(() => disk.scanStart('drive:Z', deps(l([]))), /not a place/);
  await assert.rejects(() => disk.scanStart(undefined, deps(l([]))), /not a place/);
});

test('a new start forgets the old listings: their ids stop working', async () => {
  const a = await disk.scanStart('profile', deps(list([row('Old', 'folder', 1)])));
  const oldId = a.rows[0].id;
  assert.ok(disk.resolve(oldId));
  await disk.scanStart('pdata', deps(list([row('New', 'folder', 1)])));
  assert.throws(() => disk.resolve(oldId), /not in the latest listing/);
});

test('a whole drive says how much was not counted (used minus what could be read), but not when the scan was cut short', async () => {
  const c = await disk.scanStart('drive:C', deps(list([row('Windows', 'folder', 60)])));
  assert.equal(c.notCounted, 40);
  assert.deepEqual(c.drive, { letter: 'C', used: 100, size: 475 });
  const cut = await disk.scanStart('drive:C', deps(list([row('Windows', 'folder', 60)], { partial: true })));
  assert.equal(cut.notCounted, null);
  const over = await disk.scanStart('drive:D', deps(list([row('Big', 'folder', 80)])));
  assert.equal(over.notCounted, null, 'counted more than the drive says is used (hard links): no negative figure');
});

test('Stop and a new scan both cancel a running one', async () => {
  const slow = (r) => (p, { signal }) => new Promise((resolve) => { r.signal = signal; signal.addEventListener('abort', () => resolve({ total: 0, rows: [], rest: null, links: 0, denied: 0, partial: true })); });
  const first = {};
  const running = disk.scanStart('profile', deps(slow(first)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(first.signal.aborted, false);
  disk.cancel();
  assert.equal(first.signal.aborted, true);
  assert.equal((await running).partial, true);

  const a = {};
  const b = {};
  const p1 = disk.scanStart('profile', deps(slow(a)));
  await new Promise((r) => setTimeout(r, 20));
  const p2 = disk.scanStart('pf', deps(slow(b)));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.signal.aborted, true, 'starting another scan stopped the first');
  assert.equal(b.signal.aborted, false);
  disk.cancel();
  await Promise.all([p1, p2]);
});

test('the real start list works: your folder, the program folders and the drives of this PC', async () => {
  const keys = (await disk.startList()).map((s) => s.key);
  assert.ok(keys.includes('profile') && keys.includes('pf') && keys.includes('drive:C'), keys.join(','));
});
