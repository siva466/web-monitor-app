const test = require('node:test');
const assert = require('node:assert/strict');
const { listBin, emptyBin, binUsage, SHOW, LIST_SCRIPT, _forget } = require('./recyclebin');
const { execFileSync } = require('child_process');

test.beforeEach(() => _forget());

const item = (name, binPath, over = {}) => ({ name, from: 'C:\\Users\\u\\Downloads', deleted: '2026-10-25T13:00:00.000Z', isFolder: false, binPath, ...over });
const bin = (items, sizes, over = {}) => {
  const live = { items: [...items], cleared: 0 };
  return {
    live,
    deps: { readItems: async () => live.items.map((i) => ({ ...i })), sizeOf: async (p) => { if (!(p in sizes)) throw new Error('unreadable'); return sizes[p]; }, clear: async () => { live.cleared++; live.items = live.items.filter(() => false); }, ...over },
  };
};
const A = 'C:\\$Recycle.Bin\\S-1\\$RAAA';
const B = 'C:\\$Recycle.Bin\\S-1\\$RBBB';
const D1 = 'D:\\$Recycle.Bin\\S-1\\$RDDD';

test('the list is what the shell shows, biggest first, with totals per drive; the window gets no internal paths', async () => {
  const { deps } = bin([item('small.txt', A), item('big.iso', B), item('on-d.bin', D1)], { [A]: 10, [B]: 500, [D1]: 40 });
  const r = await listBin(deps);
  assert.deepEqual(r.shown.map((x) => [x.name, x.bytes, x.drive]), [['big.iso', 500, 'C'], ['on-d.bin', 40, 'D'], ['small.txt', 10, 'C']]);
  assert.deepEqual(r.totals, { items: 3, bytes: 550 });
  assert.deepEqual(r.drives, [{ drive: 'C', items: 2, bytes: 510 }, { drive: 'D', items: 1, bytes: 40 }]);
  assert.ok(r.shown.every((x) => !('binPath' in x)));
  assert.equal(r.hidden, 0);
});

test('an empty bin lists nothing (the orphaned $I records in the raw folder are not the shell\'s items); an unreadable entry counts as 0, never a guess', async () => {
  const empty = await listBin(bin([], {}).deps);
  assert.deepEqual([empty.totals, empty.shown, empty.drives], [{ items: 0, bytes: 0 }, [], []]);
  const odd = await listBin(bin([item('locked', A)], {}).deps);
  assert.deepEqual([odd.shown[0].bytes, odd.totals.bytes], [0, 0]);
});

test('only the biggest 100 are sent, but the totals and the count of hidden ones cover every item', async () => {
  const items = Array.from({ length: SHOW + 25 }, (_, i) => item(`f${i}`, `C:\\$Recycle.Bin\\S-1\\$R${i}`));
  const sizes = Object.fromEntries(items.map((it, i) => [it.binPath, i + 1]));
  const r = await listBin(bin(items, sizes).deps);
  assert.equal(r.shown.length, SHOW);
  assert.equal(r.hidden, 25);
  assert.equal(r.totals.items, SHOW + 25);
  assert.equal(r.totals.bytes, ((SHOW + 25) * (SHOW + 26)) / 2);
  assert.equal(r.shown[0].bytes, SHOW + 25);
});

test('emptying needs a listing first, then empties exactly what was listed and reports what is left', async () => {
  const { deps, live } = bin([item('a', A), item('b', B)], { [A]: 100, [B]: 200 });
  await assert.rejects(() => emptyBin(deps), /Look at the Recycle Bin first/);
  assert.equal(live.cleared, 0);
  await listBin(deps);
  const r = await emptyBin(deps);
  assert.deepEqual([r.status, r.freedBytes, r.remaining, r.message], ['emptied', 300, 0, 'Emptied 2 items.']);
  assert.equal(live.cleared, 1);
  const again = await emptyBin(deps);
  assert.deepEqual([again.status, again.freedBytes], ['empty', 0]);
  assert.equal(live.cleared, 1, 'nothing to empty: the command is not run');
});

test('anything that arrived after you looked stops the emptying, even when the number of items is the same', async () => {
  const { deps, live } = bin([item('a', A), item('b', B)], { [A]: 1, [B]: 2, 'C:\\$Recycle.Bin\\S-1\\$RNEW': 3 });
  await listBin(deps);
  live.items = [item('a', A), item('new', 'C:\\$Recycle.Bin\\S-1\\$RNEW')]; // b left, a new one arrived: still two items
  await assert.rejects(() => emptyBin(deps), /changed since you looked: 1 new item/);
  assert.equal(live.cleared, 0, 'nothing was emptied');
  live.items = [item('a', A)]; // something only left: fine
  assert.equal((await emptyBin(deps)).status, 'emptied');
});

test('the outcome is what is left, not what the command said: items that stay are reported, and an error from the command changes nothing', async () => {
  const stay = bin([item('a', A), item('b', B)], { [A]: 100, [B]: 200 });
  stay.deps.clear = async () => { stay.live.items = stay.live.items.filter((i) => i.name === 'b'); };
  await listBin(stay.deps);
  const r = await emptyBin(stay.deps);
  assert.deepEqual([r.status, r.remaining, r.freedBytes], ['partial', 1, 100]);
  assert.match(r.message, /1 item could not be removed/);

  const noisy = bin([item('a', A)], { [A]: 5 });
  noisy.deps.clear = async () => { noisy.live.items = []; throw new Error('drive D has no recycle bin'); }; // complains although it worked
  await listBin(noisy.deps);
  assert.equal((await emptyBin(noisy.deps)).status, 'emptied');
  const failed = bin([item('a', A)], { [A]: 5 });
  failed.deps.clear = async () => { throw new Error('boom'); }; // did nothing
  await listBin(failed.deps);
  assert.deepEqual((({ status, remaining }) => ({ status, remaining }))(await emptyBin(failed.deps)), { status: 'partial', remaining: 1 });
});

test('bytes held per drive, for the "will this batch fit?" check', async () => {
  const { deps } = bin([item('a', A), item('b', B), item('c', D1)], { [A]: 10, [B]: 20, [D1]: 5 });
  assert.deepEqual(await binUsage(deps), { C: 30, D: 5 });
});

test('the real list script returns a list (empty or not), read-only, with the fields the app needs', () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { encoding: 'utf8', windowsHide: true }).trim();
  const list = [].concat(JSON.parse(out || '[]'));
  assert.ok(Array.isArray(list));
  for (const x of list) {
    assert.ok(typeof x.name === 'string' && typeof x.binPath === 'string' && /^[A-Za-z]:\\\$Recycle\.Bin\\/i.test(x.binPath), JSON.stringify(x));
    assert.equal(typeof x.isFolder, 'boolean');
  }
});
