const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { scanLarge, trashLarge, annotate } = require('./downloads');

const DAY = 86400000;
const bases = [];
// Every test works in its own throwaway "Downloads" folder; the real one is never touched.
const sandbox = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-dl-test-'));
  bases.push(base);
  const root = path.join(base, 'Downloads');
  fs.mkdirSync(root);
  return { base, root };
};
const write = (p, size) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  return p;
};
const itemOf = (p) => { const st = fs.lstatSync(p); return { path: p, bytes: st.size, modifiedMs: st.mtimeMs }; };
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));

// stand-ins for Windows: a normal Recycle Bin that keeps what it is given, with nothing in it yet
const bin = (over = {}) => {
  const calls = [];
  return { calls, deps: { binInfo: async () => ({ driveType: 3, nuke: false, maxBytes: null }), binUsage: async () => ({}), trashItem: async (p) => { calls.push(p); await fsp.rm(p); }, ...over } };
};

test('scan: files at or above the size, biggest first, with folder and age; smaller ones only counted', async () => {
  const { root } = sandbox();
  write(path.join(root, 'small.txt'), 100);
  write(path.join(root, 'mid.zip'), 5000);
  write(path.join(root, 'sub', 'deeper', 'big.iso'), 20000);
  write(path.join(root, 'sub', 'exact.bin'), 1000);
  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(path.join(root, 'mid.zip'), old, old);
  const r = await scanLarge(root, { minBytes: 1000 });
  assert.deepEqual(r.files.map((f) => [f.name, f.bytes, f.folder]), [['big.iso', 20000, path.join('sub', 'deeper')], ['mid.zip', 5000, ''], ['exact.bin', 1000, 'sub']]);
  assert.equal(r.files[1].ageDays, 40);
  assert.equal(r.files[0].path, path.join(root, 'sub', 'deeper', 'big.iso'));
  assert.deepEqual([r.matching, r.matchingBytes, r.scanned.files, r.scanned.bytes], [3, 26000, 4, 26100]);
});

test('scan: a link is never followed, so a big file behind a junction is not listed or counted', async () => {
  const { base, root } = sandbox();
  write(path.join(base, 'outside', 'huge.bin'), 50000);
  fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'portal'), 'junction');
  write(path.join(root, 'real.bin'), 3000);
  const r = await scanLarge(root, { minBytes: 1000 });
  assert.deepEqual(r.files.map((f) => f.name), ['real.bin']);
  assert.equal(r.scanned.files, 1);
});

test('scan: only the biggest `max` are returned, while the matching count and size cover all of them', async () => {
  const { root } = sandbox();
  for (let i = 1; i <= 5; i++) write(path.join(root, `f${i}.bin`), i * 1000);
  const r = await scanLarge(root, { minBytes: 1000, max: 2 });
  assert.deepEqual(r.files.map((f) => f.bytes), [5000, 4000]);
  assert.deepEqual([r.matching, r.matchingBytes], [5, 15000]);
});

test('scan: a folder that cannot be read is counted as denied, not guessed', async () => {
  const { root } = sandbox();
  write(path.join(root, 'ok', 'a.bin'), 2000);
  write(path.join(root, 'bad', 'b.bin'), 2000);
  const fsApi = { ...fsp, readdir: (p, o) => (p.endsWith('bad') ? Promise.reject(Object.assign(new Error('denied'), { code: 'EPERM' })) : fsp.readdir(p, o)), lstat: fsp.lstat };
  const r = await scanLarge(root, { minBytes: 1000, fsApi });
  assert.deepEqual(r.files.map((f) => f.name), ['a.bin']);
  assert.equal(r.scanned.denied, 1);
});

test('trash: chosen files go to the Recycle Bin and are verified gone; everything else stays', async () => {
  const { root } = sandbox();
  const a = write(path.join(root, 'a.iso'), 3000);
  const b = write(path.join(root, 'sub', 'b.zip'), 2000);
  const keep = write(path.join(root, 'keep.mkv'), 9000);
  const { calls, deps } = bin();
  const r = await trashLarge(root, [itemOf(a), itemOf(b)], deps);
  assert.deepEqual([r.moved, r.failed, r.freedBytes], [2, 0, 5000]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true]);
  assert.deepEqual(calls, [a, b]);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b) && fs.existsSync(keep));
});

test('trash: nothing outside Downloads can be removed, however the path is written', async () => {
  const { base, root } = sandbox();
  const outside = write(path.join(base, 'Documents', 'thesis.docx'), 4000);
  const sibling = write(path.join(base, 'Downloads-old', 'x.bin'), 4000); // shares the name prefix
  const dotted = path.join(root, '..', 'Documents', 'thesis.docx');
  const { calls, deps } = bin();
  const r = await trashLarge(root, [itemOf(outside), itemOf(sibling), { ...itemOf(outside), path: dotted }, { path: root, bytes: 0, modifiedMs: 0 }], deps);
  assert.equal(r.moved, 0);
  assert.equal(r.failed, 4);
  assert.ok(r.results.every((x) => /not inside the Downloads folder/.test(x.error)));
  assert.deepEqual(calls, []);
  assert.ok(fs.existsSync(outside) && fs.existsSync(sibling));
});

test('trash: a file reached through a link is refused and the real file behind the link is untouched', async () => {
  const { base, root } = sandbox();
  const target = write(path.join(base, 'elsewhere', 'precious.bin'), 4000);
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(root, 'portal'), 'junction');
  const { calls, deps } = bin();
  const r = await trashLarge(root, [{ path: path.join(root, 'portal', 'precious.bin'), bytes: 4000, modifiedMs: fs.lstatSync(target).mtimeMs }], deps);
  assert.equal(r.moved, 0);
  assert.match(r.results[0].error, /link/);
  assert.deepEqual(calls, []);
  assert.ok(fs.existsSync(target));
});

test('trash: a file that changed since the scan (size or modified time) is left alone', async () => {
  const { root } = sandbox();
  const grew = write(path.join(root, 'grew.bin'), 3000);
  const touched = write(path.join(root, 'touched.bin'), 3000);
  const same = write(path.join(root, 'same.bin'), 3000);
  const items = [grew, touched, same].map(itemOf);
  fs.appendFileSync(grew, 'more');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(touched, later, later);
  const { calls, deps } = bin();
  const r = await trashLarge(root, items, deps);
  assert.deepEqual(r.results.map((x) => x.ok), [false, false, true]);
  assert.match(r.results[0].error, /changed since the scan/);
  assert.match(r.results[1].error, /changed since the scan/);
  assert.deepEqual(calls, [same]);
  assert.ok(fs.existsSync(grew) && fs.existsSync(touched));
});

test('trash: a folder in place of the file is refused; a file that is already gone is reported as such and not counted', async () => {
  const { root } = sandbox();
  fs.mkdirSync(path.join(root, 'was-a-file.bin'));
  const gone = write(path.join(root, 'gone.bin'), 3000);
  const item = itemOf(gone);
  fs.rmSync(gone);
  const { calls, deps } = bin();
  const r = await trashLarge(root, [{ path: path.join(root, 'was-a-file.bin'), bytes: 3000, modifiedMs: 0 }, item], deps);
  assert.match(r.results[0].error, /not a plain file/);
  assert.deepEqual([r.results[1].ok, r.results[1].already], [true, true]);
  assert.deepEqual([r.moved, r.failed, r.freedBytes], [0, 1, 0]);
  assert.deepEqual(calls, []);
});

test('trash: the Recycle Bin of the drive is asked first, for the drive root', async () => {
  const { root } = sandbox();
  const asked = [];
  const a = write(path.join(root, 'a.bin'), 3000);
  const { deps } = bin({ binInfo: async (r) => { asked.push(r); return { driveType: 3, nuke: false, maxBytes: null }; } });
  await trashLarge(root, [itemOf(a)], deps);
  assert.deepEqual(asked, [`${path.parse(root).root.slice(0, 2).toUpperCase()}\\`]);
});

test('trash: a drive without a bin, a "delete immediately" setting, or a file too big to be sure it fits all refuse before anything moves', async () => {
  const cases = [
    [{ driveType: 5, nuke: false, maxBytes: null }, 3000, /no Recycle Bin/],
    [{ driveType: 3, nuke: true, maxBytes: null }, 3000, /delete files immediately/],
    [{ driveType: 3, nuke: false, maxBytes: null }, 1500, /too big/], // with binLimit 1000
    [{ driveType: 3, nuke: false, maxBytes: 2000 }, 1500, /too big/], // more than half of a 2000-byte bin
  ];
  for (const [info, size, why] of cases) {
    const { root } = sandbox();
    const f = write(path.join(root, 'f.bin'), size);
    const { calls, deps } = bin({ binInfo: async () => info, binLimit: 1000 });
    const r = await trashLarge(root, [itemOf(f)], deps);
    assert.match(r.results[0].error, why, JSON.stringify(info));
    assert.deepEqual(calls, []);
    assert.ok(fs.existsSync(f));
  }
});

test('trash: the whole batch must fit in the bin\'s free room, or nothing moves (a full bin deletes its oldest items for good)', async () => {
  const names = ['a', 'b', 'c'];
  const setup = (used) => {
    const { root } = sandbox();
    const files = names.map((n) => write(path.join(root, `${n}.bin`), 2000));
    const b = bin({ binInfo: async () => ({ driveType: 3, nuke: false, maxBytes: 10000 }), binUsage: async () => ({ [path.parse(root).root[0].toUpperCase()]: used }) });
    return { root, files, ...b };
  };
  const exact = setup(4000); // room 6000, batch 6000
  const ok = await trashLarge(exact.root, exact.files.map(itemOf), exact.deps);
  assert.deepEqual([ok.moved, ok.failed], [3, 0], 'an exact fit is allowed');

  const over = setup(4001); // room 5999, batch 6000
  const no = await trashLarge(over.root, over.files.map(itemOf), over.deps);
  assert.deepEqual([no.moved, no.failed], [0, 3]);
  assert.ok(no.results.every((x) => /has room for about .* more and these files add up to .*nothing was removed/.test(x.error)));
  assert.deepEqual(over.calls, []);
  assert.ok(over.files.every((f) => fs.existsSync(f)));
});

test('trash: only the files the bin would keep count toward the batch', async () => {
  const { root } = sandbox();
  const big = write(path.join(root, 'big.bin'), 5001); // more than half of a 10000-byte bin: refused on its own
  const a = write(path.join(root, 'a.bin'), 2000);
  const b = write(path.join(root, 'b.bin'), 2000);
  const { calls, deps } = bin({ binInfo: async () => ({ driveType: 3, nuke: false, maxBytes: 10000 }), binUsage: async () => ({ [path.parse(root).root[0].toUpperCase()]: 5000 }) }); // room 5000
  const r = await trashLarge(root, [big, a, b].map(itemOf), deps);
  assert.deepEqual(r.results.map((x) => x.ok), [false, true, true]);
  assert.match(r.results[0].error, /too big/);
  assert.deepEqual(calls, [a, b]);
});

test('trash: when the bin cannot be read or checked, nothing is removed', async () => {
  for (const over of [{ binUsage: async () => { throw new Error('no'); } }, { binInfo: async () => { throw new Error('no'); } }]) {
    const { root } = sandbox();
    const f = write(path.join(root, 'f.bin'), 3000);
    const { calls, deps } = bin(over);
    const r = await trashLarge(root, [itemOf(f)], deps);
    assert.equal(r.moved, 0);
    assert.match(r.results[0].error, /could not be (read|checked)/);
    assert.deepEqual(calls, []);
    assert.ok(fs.existsSync(f));
  }
});

test('trash: the bin\'s usage is read once for the batch, not once per file', async () => {
  const { root } = sandbox();
  const files = ['a', 'b', 'c'].map((n) => write(path.join(root, `${n}.bin`), 1000));
  let reads = 0;
  const { deps } = bin({ binUsage: async () => { reads++; return {}; } });
  await trashLarge(root, files.map(itemOf), deps);
  assert.equal(reads, 1);
});

test('trash: a move that hangs is given up on and reported, a move that errors is reported, a move that did nothing is caught; the rest continue', async () => {
  const { root } = sandbox();
  const hang = write(path.join(root, 'hang.bin'), 1000);
  const boom = write(path.join(root, 'boom.bin'), 1000);
  const lie = write(path.join(root, 'lie.bin'), 1000);
  const fine = write(path.join(root, 'fine.bin'), 1000);
  const { deps } = bin({
    trashTimeoutMs: 80,
    trashItem: async (p) => {
      if (p === hang) return new Promise(() => {});
      if (p === boom) throw new Error('in use');
      if (p === lie) return; // says yes, does nothing
      await fsp.rm(p);
    },
  });
  const r = await trashLarge(root, [hang, boom, lie, fine].map(itemOf), deps);
  assert.deepEqual(r.results.map((x) => x.ok), [false, false, false, true]);
  assert.match(r.results[0].error, /did not finish/);
  assert.match(r.results[1].error, /could not move it/);
  assert.match(r.results[2].error, /still there after the move/);
  assert.deepEqual([r.moved, r.failed, r.freedBytes], [1, 3, 1000]);
});

test('annotate: a file the bin would not keep gets the reason, the rest get null, and the bin is asked once per drive', async () => {
  const files = [{ path: 'C:\\Users\\u\\Downloads\\ok.bin', bytes: 500 }, { path: 'C:\\Users\\u\\Downloads\\huge.iso', bytes: 1500 }, { path: 'C:\\Users\\u\\Downloads\\sub\\ok2.bin', bytes: 900 }];
  const asked = [];
  const r = await annotate(files, { binLimit: 1000, binInfo: async (root) => { asked.push(root); return { driveType: 3, nuke: false, maxBytes: null }; } });
  assert.deepEqual(r.map((f) => f.whyNot === null), [true, false, true]);
  assert.match(r[1].whyNot, /too big to be sure the Recycle Bin can hold it/);
  assert.deepEqual(asked, ['C:\\']);
  assert.deepEqual(r.map((f) => f.path), files.map((f) => f.path), 'the files come back in the same order, otherwise unchanged');

  const noBin = await annotate(files.slice(0, 1), { binInfo: async () => ({ driveType: 5, nuke: false, maxBytes: null }) });
  assert.match(noBin[0].whyNot, /no Recycle Bin/);
  const nuke = await annotate(files.slice(0, 1), { binInfo: async () => ({ driveType: 3, nuke: true, maxBytes: null }) });
  assert.match(nuke[0].whyNot, /delete files immediately/);
  const half = await annotate([{ path: 'C:\\d\\a.bin', bytes: 1500 }], { binInfo: async () => ({ driveType: 3, nuke: false, maxBytes: 2000 }) });
  assert.match(half[0].whyNot, /too big/, 'more than half of a small bin');
  const broken = await annotate(files.slice(0, 1), { binInfo: async () => { throw new Error('no'); } });
  assert.match(broken[0].whyNot, /could not be checked/);
  assert.deepEqual(await annotate([]), []);
});

test('trash: without a real Recycle Bin behind it, nothing is ever deleted', async () => {
  const { root } = sandbox();
  const f = write(path.join(root, 'f.bin'), 3000);
  const r = await trashLarge(root, [itemOf(f)], { binInfo: async () => ({ driveType: 3, nuke: false, maxBytes: null }), binUsage: async () => ({}) });
  assert.equal(r.moved, 0);
  assert.ok(fs.existsSync(f));
});
