const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanLeftovers, stillInstalled, manualSnapshot, candidates, cleanName, cleanPublisher } = require('./leftovers');

const bases = [];
test.after(() => bases.forEach((b) => fs.rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
const sandbox = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-left-test-'));
  bases.push(base);
  const roots = { files: ['pf', 'appdata', 'local'].map((d) => path.join(base, d)), registry: ['HKEY_CURRENT_USER\\Software', 'HKEY_LOCAL_MACHINE\\SOFTWARE'] };
  roots.files.forEach((d) => fs.mkdirSync(d, { recursive: true }));
  return { base, roots };
};
const put = (p, size = 100) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
};
const PUTTY = { key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}', name: 'PuTTY release 0.85 (64-bit)', publisher: 'Simon Tatham', location: null };
const noRegistry = async () => [];

test('cleans display names and publishers', () => {
  assert.equal(cleanName('PuTTY release 0.85 (64-bit)'), 'PuTTY');
  assert.equal(cleanName('7-Zip 26.04 (x64 edition)'), '7-Zip');
  assert.equal(cleanName('Mp3tag v3.36.1'), 'Mp3tag'); // found live: a "v" glued to the number used to leave "Mp3tag v3."
  assert.equal(cleanName('Foo v2.1'), 'Foo');
  assert.equal(cleanName('Vivaldi'), 'Vivaldi'); // a name that merely contains a v is untouched
  assert.equal(cleanName('Node.js'), 'Node.js');
  assert.equal(cleanName('Visual Studio Build Tools 2026'), 'Visual Studio Build Tools 2026');
  assert.equal(cleanPublisher('Brave Software Inc.'), 'Brave Software');
  assert.equal(cleanPublisher('Simon Tatham'), 'Simon Tatham');
  assert.equal(cleanPublisher('Igor Pavlov'), 'Igor Pavlov');
});

test('names used for matching: both spellings, the install folder name, nothing short or generic', () => {
  const c = candidates(PUTTY);
  assert.deepEqual(c.names, ['PuTTY']);
  assert.deepEqual(c.publishers, ['Simon Tatham', 'SimonTatham']); // PuTTY's own registry key has no space
  assert.deepEqual(candidates({ name: 'Git', publisher: 'The Git Development Community', location: null }).names, []); // 3 letters: too short to match safely
  assert.deepEqual(candidates({ name: 'Microsoft', publisher: 'Microsoft', location: null }), { names: [], publishers: [] });
  assert.ok(candidates({ name: 'Weird Name', publisher: 'X', location: 'C:\\Program Files\\RealFolder\\' }).names.includes('RealFolder'));
});

test('finds leftover folders and registry keys with the right confidence, and nothing unrelated', async () => {
  const { base, roots } = sandbox();
  const recorded = path.join(base, 'pf', 'PuTTY');
  put(path.join(recorded, 'putty.exe'), 500);
  put(path.join(base, 'appdata', 'Simon Tatham', 'PuTTY', 'sessions', 'default'), 300);
  put(path.join(base, 'local', 'Unrelated', 'file.txt'));
  put(path.join(base, 'local', 'SimonTatham.txt')); // a file named like the publisher but with an extension: not a match

  const registry = async (keys) => keys.filter((k) => /SimonTatham$|SimonTatham\\PuTTY$|Uninstall\\\{GUID\}$/.test(k)).map((key) => ({ key, subkeys: 2, values: 1 }));
  const r = await scanLeftovers({ ...PUTTY, location: recorded }, { roots, checkRegistry: registry });
  const by = Object.fromEntries(r.items.map((i) => [i.path.replace(base, '').replace(/^[\\/]/, ''), i]));

  assert.equal(by['pf\\PuTTY'].confidence, 'high'); // the folder the app recorded wins over a name match
  assert.equal(by['pf\\PuTTY'].sizeBytes, 500);
  assert.equal(by['appdata\\Simon Tatham\\PuTTY'].confidence, 'medium');
  assert.equal(by['appdata\\Simon Tatham'].confidence, 'low');
  assert.equal(by['HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}'].confidence, 'high');
  assert.equal(by['HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY'].confidence, 'medium');
  assert.equal(by['HKEY_CURRENT_USER\\Software\\SimonTatham'].confidence, 'low');
  assert.ok(!Object.keys(by).some((k) => /Unrelated|SimonTatham\.txt/.test(k)));
  assert.deepEqual(r.items.map((i) => i.confidence), [...r.items.map((i) => i.confidence)].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a] - ({ high: 0, medium: 1, low: 2 })[b]));
  assert.equal(new Set(r.items.map((i) => i.path.toLowerCase())).size, r.items.length, 'no path is listed twice');
});

test('a clean system gives an empty result, and nothing is changed or deleted by the scan', async () => {
  const { base, roots } = sandbox();
  put(path.join(base, 'local', 'Unrelated', 'file.txt'));
  const before = fs.readdirSync(path.join(base, 'local', 'Unrelated'));
  const r = await scanLeftovers({ ...PUTTY, key: 'HKEY_X\\Uninstall\\none' }, { roots, checkRegistry: noRegistry });
  assert.deepEqual(r.items, []);
  assert.ok(r.placesChecked > 0);
  assert.deepEqual(fs.readdirSync(path.join(base, 'local', 'Unrelated')), before);
});

test('a typed-in name that matches a program that is still installed is caught, whole or in part', () => {
  const installed = [{ name: 'Google Chrome' }, { name: '7-Zip 26.04 (x64 edition)' }, { name: 'Microsoft Visual Studio Build Tools 2026' }, { name: 'Node.js' }];
  assert.equal(stillInstalled('Chrome', installed).name, 'Google Chrome'); // the typed name is a word of an installed name
  assert.equal(stillInstalled('google chrome', installed).name, 'Google Chrome'); // any case
  assert.equal(stillInstalled('Google Chrome Beta Helper', installed).name, 'Google Chrome'); // the installed name is inside what was typed
  assert.equal(stillInstalled('7-Zip', installed).name, '7-Zip 26.04 (x64 edition)');
  assert.equal(stillInstalled('Visual Studio', installed).name, 'Microsoft Visual Studio Build Tools 2026');
  assert.equal(stillInstalled('Node.js', installed).name, 'Node.js');
  assert.equal(stillInstalled('PuTTY', installed), null);
  assert.equal(stillInstalled('Firefox', installed), null);
  assert.equal(stillInstalled('', installed), null);
  assert.equal(stillInstalled('PuTTY', []), null);
});

test('typed names are validated before anything is scanned', () => {
  assert.deepEqual(manualSnapshot('  PuTTY ', ' Simon Tatham '), { key: null, name: 'PuTTY', publisher: 'Simon Tatham', location: null });
  assert.equal(manualSnapshot('PuTTY', '').publisher, null);
  for (const bad of ['', 'ab', '-rf', 'a;b', 'x'.repeat(61), '..\\x']) assert.throws(() => manualSnapshot(bad, ''), /program name/, JSON.stringify(bad));
  assert.throws(() => manualSnapshot('PuTTY', 'a;b'), /publisher/);
});

test('a folder that is, or holds, the install folder of a program still installed is never listed', async () => {
  const { base, roots } = sandbox();
  put(path.join(base, 'pf', 'PuTTY', 'putty.exe'));
  put(path.join(base, 'appdata', 'Simon Tatham', 'PuTTY', 'keep.txt'));
  const installed = [{ name: 'Other', location: path.join(base, 'pf', 'PuTTY') }];
  const r = await scanLeftovers({ ...PUTTY, key: null }, { roots, checkRegistry: noRegistry, installed });
  assert.ok(!r.items.some((i) => i.path === path.join(base, 'pf', 'PuTTY')), 'the installed program\'s own folder is left out');
  assert.ok(r.items.some((i) => i.path === path.join(base, 'appdata', 'Simon Tatham', 'PuTTY')));
  assert.equal(r.keptInstalled, 1);
  const parentOfInstalled = [{ name: 'Other', location: path.join(base, 'appdata', 'Simon Tatham', 'PuTTY', 'bin') }];
  const r2 = await scanLeftovers({ ...PUTTY, key: null }, { roots, checkRegistry: noRegistry, installed: parentOfInstalled });
  assert.ok(!r2.items.some((i) => i.path.startsWith(path.join(base, 'appdata', 'Simon Tatham'))), 'a folder that holds an installed program\'s folder is left out too');
});

test('items get ids and the empty / too-big flags that removal relies on', async () => {
  const { base, roots } = sandbox();
  fs.mkdirSync(path.join(base, 'local', 'SimonTatham'));
  put(path.join(base, 'pf', 'PuTTY', 'a.txt'), 50);
  const r = await scanLeftovers({ ...PUTTY, key: null }, { roots, checkRegistry: noRegistry });
  assert.deepEqual(r.items.map((i) => i.id), r.items.map((_, i) => String(i)));
  const empty = r.items.find((i) => i.path.endsWith('SimonTatham'));
  assert.equal(empty.empty, true);
  assert.equal(empty.confidence, 'low');
  assert.equal(r.items.find((i) => i.path.endsWith('PuTTY')).empty, false);
  assert.ok(r.items.every((i) => i.tooBig === false));
});

test('a link is never followed or reported', async () => {
  const { base, roots } = sandbox();
  const outside = path.join(base, 'outside');
  put(path.join(outside, 'x.txt'));
  fs.symlinkSync(outside, path.join(base, 'pf', 'PuTTY'), 'junction');
  const r = await scanLeftovers(PUTTY, { roots, checkRegistry: noRegistry });
  assert.deepEqual(r.items, []);
  assert.ok(fs.existsSync(path.join(outside, 'x.txt')));
});
