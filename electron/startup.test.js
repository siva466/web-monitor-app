const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStartup, SOURCES } = require('./startup');

const e = (over) => ({ scope: 'user', source: 'run', name: 'App', command: 'C:\\app.exe', flag: null, ...over });

test('flag decides on/off: none, 02 and 06 are on; 03 and 07 are off', () => {
  const on = (flag) => parseStartup([e({ flag })])[0].enabled;
  assert.equal(on(null), true);
  assert.equal(on(undefined), true);
  assert.equal(on(2), true);
  assert.equal(on(6), true);
  assert.equal(on(3), false);
  assert.equal(on(7), false);
});

test('ids are unique per place, folder items lose .lnk, empty names are dropped, list is sorted', () => {
  const list = parseStartup([
    e({ name: 'beta' }),
    e({ name: 'Alpha', scope: 'machine' }),
    e({ name: 'Zip.lnk', source: 'folder' }),
    e({ name: '' }),
    null,
  ]);
  assert.deepEqual(list.map((x) => x.name), ['Alpha', 'beta', 'Zip']);
  assert.equal(list[0].id, 'machine|run|Alpha');
  assert.equal(list[2].valueName, 'Zip.lnk');
});

test('single object, null and empty input are accepted', () => {
  assert.equal(parseStartup(e({})).length, 1);
  assert.deepEqual(parseStartup(null), []);
  assert.deepEqual(parseStartup([]), []);
});

test('every place has its own StartupApproved key', () => {
  const keys = SOURCES.map((s) => s.approved);
  assert.equal(new Set(keys).size, SOURCES.length);
  assert.ok(keys.every((k) => k.includes('StartupApproved')));
});
