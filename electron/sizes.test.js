const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { listFolder, measure, limiter, dirEntrySizes } = require('./sizes');

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const tree = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-size-test-'));
  bases.push(base);
  return base;
};
const put = (p, size) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); };
const fake = (over) => ({ readdir: (...a) => fsp.readdir(...a), lstat: (...a) => fsp.lstat(...a), ...over });
const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' });

test('children come back with their real sizes, biggest first, files counted, and the total is their sum', async () => {
  const b = tree();
  put(path.join(b, 'a', 'x.bin'), 100);
  put(path.join(b, 'a', 'sub', 'y.bin'), 200);
  put(path.join(b, 'a', 'sub', 'deep', 'z.bin'), 300);
  put(path.join(b, 'e.txt'), 50);
  fs.mkdirSync(path.join(b, 'empty'));
  const r = await listFolder(b);
  assert.deepEqual(r.rows.map((c) => [c.name, c.kind, c.bytes, c.files]), [['a', 'folder', 600, 3], ['e.txt', 'file', 50, 1], ['empty', 'folder', 0, 0]]);
  assert.equal(r.total, 650);
  assert.deepEqual([r.rest, r.denied, r.partial, r.links], [null, 0, false, 0]);
});

test('a junction is not followed: what it points at is not counted, and it is reported as a skipped link', async () => {
  const b = tree();
  const outside = path.join(tree(), 'outside');
  put(path.join(outside, 'huge.bin'), 5000);
  put(path.join(b, 'mine', 'a.bin'), 10);
  fs.symlinkSync(outside, path.join(b, 'mine', 'portal'), 'junction');
  fs.symlinkSync(outside, path.join(b, 'topportal'), 'junction');
  const r = await listFolder(b);
  assert.equal(r.total, 10, 'nothing from the other side of either link');
  assert.equal(r.rows.find((c) => c.name === 'mine').bytes, 10);
  assert.deepEqual(r.rows.find((c) => c.name === 'topportal'), { name: 'topportal', kind: 'link', bytes: 0, files: 0, denied: 0, partial: false });
  assert.equal(r.links, 2, 'the link at the top and the one inside a folder');
  assert.ok(fs.existsSync(path.join(outside, 'huge.bin')));
});

test('places that cannot be read are counted, not hidden, and the rest still adds up', async () => {
  const b = tree();
  put(path.join(b, 'ok', 'a.bin'), 100);
  put(path.join(b, 'locked', 'b.bin'), 999);
  put(path.join(b, 'ok', 'secret.bin'), 777);
  const api = fake({
    readdir: async (d, o) => { if (d.endsWith('locked')) throw eperm(); return fsp.readdir(d, o); },
    lstat: async (p) => { if (p.endsWith('secret.bin')) throw eperm(); return fsp.lstat(p); },
  });
  const r = await listFolder(b, { fsApi: api });
  assert.equal(r.rows.find((c) => c.name === 'ok').bytes, 100);
  assert.equal(r.rows.find((c) => c.name === 'locked').bytes, 0);
  assert.equal(r.denied, 2, 'one folder and one file could not be read');
  assert.equal(r.total, 100);
});

test('a file that cannot be opened gets its size from the directory entry (pagefile.sys, hiberfil.sys); if that fails too it is counted as unreadable', async () => {
  const b = tree();
  put(path.join(b, 'normal.txt'), 10);
  put(path.join(b, 'hiberfil.sys'), 1);
  const api = fake({ lstat: async (p) => { if (p.endsWith('hiberfil.sys')) throw eperm(); return fsp.lstat(p); } });
  const withFallback = await listFolder(b, { fsApi: api, fallback: async (dir) => { assert.equal(dir, b); return { 'hiberfil.sys': 9_480_000_000 }; } });
  assert.deepEqual(withFallback.rows[0], { name: 'hiberfil.sys', kind: 'file', bytes: 9_480_000_000, files: 1, denied: 0, partial: false, note: 'Size taken from the directory; the file is in use or protected.' });
  assert.equal(withFallback.total, 9_480_000_010);
  const without = await listFolder(b, { fsApi: api, fallback: async () => { throw new Error('no powershell'); } });
  assert.deepEqual([without.rows.at(-1).name, without.rows.at(-1).bytes, without.denied], ['hiberfil.sys', 0, 1]);
  const asked = [];
  await listFolder(b, { fallback: async (d) => { asked.push(d); return {}; } });
  assert.deepEqual(asked, [], 'the fallback is only used when a file really could not be opened');
});

test('a long list is cut to the biggest rows plus one row for the rest', async () => {
  const b = tree();
  for (let i = 1; i <= 7; i++) put(path.join(b, `f${i}.bin`), i * 10);
  const r = await listFolder(b, { maxRows: 3 });
  assert.deepEqual(r.rows.map((c) => c.name), ['f7.bin', 'f6.bin', 'f5.bin']);
  assert.deepEqual(r.rest, { count: 4, bytes: 10 + 20 + 30 + 40 });
  assert.equal(r.total, 280, 'the total still counts everything');
});

test('Stop and the time cap return what has been found, marked partial', async () => {
  const b = tree();
  for (let i = 0; i < 40; i++) put(path.join(b, `d${i}`, 'f.bin'), 100);
  const ac = new AbortController();
  ac.abort();
  assert.equal((await listFolder(b, { signal: ac.signal })).partial, true);

  const slow = fake({ readdir: async (d, o) => { await new Promise((r) => setTimeout(r, 15)); return fsp.readdir(d, o); } });
  const t = Date.now();
  const r = await listFolder(b, { fsApi: slow, budgetMs: 40, concurrency: 2 });
  assert.equal(r.partial, true);
  assert.ok(Date.now() - t < 2000, 'it stopped instead of reading everything');
  assert.ok(r.total < 4000);
  assert.equal((await listFolder(b)).partial, false);
});

test('no more than the allowed number of file-system calls run at once', async () => {
  const b = tree();
  for (let i = 0; i < 30; i++) put(path.join(b, `d${i}`, 'f.bin'), 1);
  let now = 0, peak = 0;
  const api = fake({
    readdir: async (d, o) => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 3)); try { return await fsp.readdir(d, o); } finally { now--; } },
    lstat: async (p) => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 3)); try { return await fsp.lstat(p); } finally { now--; } },
  });
  const r = await listFolder(b, { fsApi: api, concurrency: 4 });
  assert.equal(r.total, 30);
  assert.ok(peak <= 5, `peak ${peak}`); // 4 for the children's walks plus the one initial listing
  const run = limiter(2);
  let n = 0, top = 0;
  await Promise.all(Array.from({ length: 10 }, () => run(async () => { n++; top = Math.max(top, n); await new Promise((r) => setTimeout(r, 5)); n--; })));
  assert.equal(top, 2);
});

test('a folder that cannot be listed at all says so', async () => {
  await assert.rejects(() => listFolder(path.join(os.tmpdir(), 'webase-no-such-folder-xyz')), /cannot be read/);
});

test('the sizes match PowerShell\'s own sum for real folders (an independent check)', async () => {
  for (const dir of [__dirname, path.join(__dirname, '..', 'src')]) {
    const ps = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -Force -File | Measure-Object Length -Sum).Sum`], { encoding: 'utf8', windowsHide: true }).trim());
    const m = await measure(dir, { fsApi: fsp, run: limiter(16), deadline: Date.now() + 60000 });
    assert.equal(m.bytes, ps, dir);
    assert.ok(m.files > 10);
  }
});

test('the directory-entry script handles one file, several, none, and a folder name with quotes and dollar signs', async () => {
  const b = tree();
  const odd = path.join(b, "it's $odd `name`");
  put(path.join(odd, 'One.TXT'), 123);
  assert.deepEqual(await dirEntrySizes(odd), { 'one.txt': 123 }, 'one file (a single result is still a list)');
  put(path.join(odd, 'two.bin'), 4);
  assert.deepEqual(await dirEntrySizes(odd), { 'one.txt': 123, 'two.bin': 4 });
  fs.mkdirSync(path.join(b, 'empty'));
  assert.deepEqual(await dirEntrySizes(path.join(b, 'empty')), {});
  assert.deepEqual(await dirEntrySizes(path.join(b, 'nope')), {});
});
