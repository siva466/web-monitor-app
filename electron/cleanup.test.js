const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { scanTarget, deleteTarget, whyRefused, MIN_AGE_MS } = require('./cleanup');

const DAY = 24 * 60 * 60 * 1000;
const OLD = MIN_AGE_MS / DAY + 3; // comfortably past the age limit, in days
const bases = [];
// Every test works in its own throwaway folder (named Temp, as the safety guard requires); the real temp folder is never touched.
const sandbox = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-cleanup-test-'));
  bases.push(base);
  const root = path.join(base, 'Temp');
  fs.mkdirSync(root);
  return { base, root, target: { id: 't', label: 'Test', path: root, needsAdmin: false } };
};
const write = (p, size = 100) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
};
const age = (p, days) => {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
};
// The PowerShell that held a file may need a moment to let go after being killed, so retry.
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));

test('lists old items; keeps recent ones and folders with a recent file inside', async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'old.txt'), 300);
  age(path.join(root, 'old.txt'), OLD);
  write(path.join(root, 'recent.txt'));
  write(path.join(root, 'olddir', 'a.txt'), 200);
  age(path.join(root, 'olddir', 'a.txt'), OLD);
  age(path.join(root, 'olddir'), OLD);
  write(path.join(root, 'mixed', 'new.txt'));
  age(path.join(root, 'mixed'), OLD); // the folder itself looks old, but a file inside is new

  const scan = await scanTarget(target);
  assert.deepEqual(scan.items.map((i) => [i.name, i.sizeBytes, i.isDir]), [['old.txt', 300, false], ['olddir', 200, true]]);
  assert.equal(scan.totalBytes, 500);
  assert.equal(scan.keptRecent, 2);
});

test('a file a few days old is still kept (the limit is a week, like Disk Cleanup)', async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'three-days.tmp'));
  age(path.join(root, 'three-days.tmp'), 3);
  const scan = await scanTarget(target);
  assert.equal(scan.items.length, 0);
  assert.equal(scan.keptRecent, 1);
});

test('never follows links: folders holding a junction are left alone and nothing outside is touched', async () => {
  const { base, root, target } = sandbox();
  const outside = path.join(base, 'outside');
  write(path.join(outside, 'precious.txt'));
  age(path.join(outside, 'precious.txt'), OLD);
  fs.symlinkSync(outside, path.join(root, 'junc'), 'junction');
  fs.mkdirSync(path.join(root, 'holder'));
  fs.symlinkSync(outside, path.join(root, 'holder', 'inner'), 'junction');
  age(path.join(root, 'holder'), OLD);
  write(path.join(root, 'plain.txt'));
  age(path.join(root, 'plain.txt'), OLD);

  const scan = await scanTarget(target);
  assert.deepEqual(scan.items.map((i) => i.name), ['plain.txt']);
  assert.equal(scan.keptLinks, 2);
  const result = await deleteTarget(scan);
  assert.equal(result.removedItems, 1);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')), 'the file the junction points to must survive');
  assert.ok(fs.existsSync(path.join(root, 'holder')) && fs.existsSync(path.join(root, 'junc')));
});

test('deletes old items, reports the bytes freed, leaves recent items alone', async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'a.tmp'), 1000);
  age(path.join(root, 'a.tmp'), OLD);
  write(path.join(root, 'dir', 'b.tmp'), 500);
  write(path.join(root, 'dir', 'deeper', 'c.tmp'), 250);
  for (const p of ['dir/b.tmp', 'dir/deeper/c.tmp', 'dir/deeper', 'dir']) age(path.join(root, p), OLD);
  write(path.join(root, 'keep.tmp'));

  const result = await deleteTarget(await scanTarget(target));
  assert.equal(result.freedBytes, 1750);
  assert.equal(result.removedItems, 2);
  assert.equal(result.failedItems, 0);
  assert.deepEqual(fs.readdirSync(root), ['keep.tmp']);
});

test('a read-only file is deleted too, and counted as freed', async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'locked-by-attribute.tmp'), 700);
  age(path.join(root, 'locked-by-attribute.tmp'), OLD);
  fs.chmodSync(path.join(root, 'locked-by-attribute.tmp'), 0o444); // sets the read-only attribute on Windows
  const result = await deleteTarget(await scanTarget(target));
  assert.equal(result.freedBytes, 700);
  assert.equal(result.removedItems, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('an item touched after the scan is kept', async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'busy.tmp'));
  age(path.join(root, 'busy.tmp'), OLD);
  const scan = await scanTarget(target);
  assert.equal(scan.items.length, 1);
  fs.utimesSync(path.join(root, 'busy.tmp'), new Date(), new Date()); // something wrote to it meanwhile
  const result = await deleteTarget(scan);
  assert.equal(result.changedSince, 1);
  assert.equal(result.removedItems, 0);
  assert.ok(fs.existsSync(path.join(root, 'busy.tmp')));
});

test('an item name that tries to leave the folder is ignored', async () => {
  const { base, target } = sandbox();
  write(path.join(base, 'outside.txt'));
  age(path.join(base, 'outside.txt'), OLD);
  const fake = { ...target, items: [{ name: '..\\outside.txt', isDir: false, sizeBytes: 100, modifiedMs: 0 }] };
  const result = await deleteTarget(fake);
  assert.equal(result.removedItems, 0);
  assert.ok(fs.existsSync(path.join(base, 'outside.txt')));
});

test('folders Windows owns (Low) are never listed, however old', async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'Low', 'x.tmp'));
  age(path.join(root, 'Low', 'x.tmp'), 30);
  age(path.join(root, 'Low'), 30);
  assert.equal((await scanTarget(target)).items.length, 0);
});

test('a folder that does not exist gives an empty result', async () => {
  const { base } = sandbox();
  const scan = await scanTarget({ id: 'x', label: 'X', path: path.join(base, 'nope', 'Temp'), needsAdmin: false });
  assert.deepEqual([scan.items.length, scan.totalBytes, scan.unreadable, scan.refused], [0, 0, 0, null]);
});

test('only clearly temp-looking folders are accepted', () => {
  const profile = process.env.USERPROFILE;
  const bad = ['C:\\', 'D:\\', 'CrashDumps', '.\\Temp', profile, path.dirname(profile), path.join(profile, 'Documents'), path.join(profile, 'Pictures'), process.env.SystemRoot, 'C:\\Program Files', 'C:\\Users'];
  for (const p of bad) assert.ok(whyRefused(p), `should refuse ${p}`);
  const good = [path.join(profile, 'AppData', 'Local', 'Temp'), path.join(process.env.SystemRoot, 'Temp'), 'C:\\Temp', path.join(profile, 'AppData', 'Local', 'CrashDumps')];
  for (const p of good) assert.equal(whyRefused(p), null, `should accept ${p}`);
});

test('a personal folder set as the temp folder is refused: scan lists nothing, delete throws, files survive', async () => {
  const { base } = sandbox();
  const docs = path.join(base, 'Documents'); // what TEMP would point at if it were misconfigured
  write(path.join(docs, 'thesis.docx'), 500);
  age(path.join(docs, 'thesis.docx'), 400);
  age(path.join(docs, 'thesis.docx'), 400);
  const target = { id: 'd', label: 'Docs', path: docs, needsAdmin: false };
  const scan = await scanTarget(target);
  assert.ok(scan.refused);
  assert.equal(scan.items.length, 0);
  const forged = { ...target, items: [{ name: 'thesis.docx', isDir: false, sizeBytes: 500, modifiedMs: 0 }] };
  await assert.rejects(() => deleteTarget(forged), /does not look like a temp folder/);
  assert.ok(fs.existsSync(path.join(docs, 'thesis.docx')));
});

test('a file in use is skipped and reported; the rest is deleted', { skip: process.platform !== 'win32' }, async () => {
  const { root, target } = sandbox();
  write(path.join(root, 'dir', 'locked.bin'), 400);
  write(path.join(root, 'dir', 'free.bin'), 600);
  for (const p of ['dir/locked.bin', 'dir/free.bin', 'dir']) age(path.join(root, p), OLD);

  // A PowerShell process holds locked.bin open with no sharing, like a program using its temp file.
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${path.join(root, 'dir', 'locked.bin')}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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
    const result = await deleteTarget(await scanTarget(target));
    assert.equal(result.freedBytes, 600, 'only the free file counts as freed');
    assert.equal(result.removedItems, 0);
    assert.equal(result.failedItems, 1);
    assert.ok(result.reasons.length > 0, 'a reason is reported');
    assert.ok(fs.existsSync(path.join(root, 'dir', 'locked.bin')));
    assert.ok(!fs.existsSync(path.join(root, 'dir', 'free.bin')));
    console.log('  reason reported for the locked file:', result.reasons);
  } finally {
    holder.kill();
  }
});
