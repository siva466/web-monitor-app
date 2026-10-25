const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDrivers, parseProblems, parseUpdates, nvidiaVersion, LINKS } = require('./drivers');

const NOW = Date.UTC(2026, 9, 25);
const d = (over) => ({ name: 'Device', cls: 'NET', provider: 'Realtek', manufacturer: 'Realtek', version: '1.0', date: '2026-01-01', signed: true, ...over });

test('converts the Windows driver version to the vendor version people know (NVIDIA)', () => {
  assert.equal(nvidiaVersion('32.0.15.6201'), '562.01');
  assert.equal(nvidiaVersion('31.0.15.4601'), '546.01');
  assert.equal(nvidiaVersion('32.0.16.2101'), '621.01');
  assert.equal(nvidiaVersion('weird'), null);
  assert.equal(nvidiaVersion(null), null);
  const [gpu] = parseDrivers([d({ name: 'GPU', cls: 'DISPLAY', provider: 'NVIDIA', version: '32.0.15.6201' })], NOW);
  assert.equal(gpu.friendlyVersion, '562.01');
  const [net] = parseDrivers([d({ provider: 'NVIDIA', cls: 'NET', version: '32.0.15.6201' })], NOW);
  assert.equal(net.friendlyVersion, null, 'only display drivers get the converted version');
});

test('flags unsigned and old third-party drivers, but not unknown signature or Microsoft inbox drivers', () => {
  const list = parseDrivers([
    d({ name: 'a-unsigned', signed: false }),
    d({ name: 'b-unknown', signed: null }),
    d({ name: 'c-old', date: '2020-01-01' }),
    d({ name: 'd-fresh', date: '2026-06-01' }),
    d({ name: 'e-ms-old', provider: 'Microsoft', date: '2006-06-21' }),
    d({ name: 'f-nodate', date: null }),
  ], NOW);
  const by = Object.fromEntries(list.map((x) => [x.name, x]));
  assert.equal(by['a-unsigned'].signed, false);
  assert.equal(by['b-unknown'].signed, null);
  assert.equal(by['c-old'].old, true);
  assert.equal(by['d-fresh'].old, false);
  assert.equal(by['e-ms-old'].old, false);
  assert.equal(by['e-ms-old'].microsoft, true);
  assert.equal(by['f-nodate'].old, false);
});

test('driver parsing tolerates one object, null, nameless rows, and falls back to the manufacturer', () => {
  assert.equal(parseDrivers(d({}), NOW).length, 1);
  assert.deepEqual(parseDrivers(null, NOW), []);
  assert.equal(parseDrivers([{ name: '' }, null], NOW).length, 0);
  assert.equal(parseDrivers([d({ provider: null, manufacturer: 'Lenovo' })], NOW)[0].provider, 'Lenovo');
});

test('problem codes become plain words, unknown codes keep their number', () => {
  const [a, b] = parseProblems([{ name: 'Z device', code: 28 }, { name: 'A device', code: 999 }]);
  assert.deepEqual([a.name, a.cause], ['A device', 'Error code 999']);
  assert.equal(b.cause, 'No driver installed');
  assert.deepEqual(parseProblems(null), []);
});

test('update rows are cleaned and sorted; empty input gives no updates', () => {
  const list = parseUpdates([
    { title: 'Zeta', manufacturer: 'X', sizeBytes: 0, downloaded: 0 },
    { title: 'Alpha', manufacturer: 'Y', sizeBytes: 2048, downloaded: true, date: '2026-05-01' },
    { title: '' },
  ]);
  assert.deepEqual(list.map((u) => u.title), ['Alpha', 'Zeta']);
  assert.equal(list[0].sizeBytes, 2048);
  assert.equal(list[1].sizeBytes, null);
  assert.equal(list[1].downloaded, false);
  assert.deepEqual(parseUpdates([]), []);
  assert.deepEqual(parseUpdates(null), []);
});

test('only known vendor pages and the Settings page can be opened', () => {
  assert.deepEqual(Object.keys(LINKS).sort(), ['amd', 'app-control', 'intel', 'nvidia', 'optional-updates']);
  const kinds = { 'optional-updates': /^ms-settings:/, 'app-control': /^windowsdefender:\/\/appbrowser$/ };
  for (const [key, url] of Object.entries(LINKS)) assert.match(url, kinds[key] ?? /^https:\/\/(www\.)?[a-z.]+\//, key);
});
