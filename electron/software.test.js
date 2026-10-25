const test = require('node:test');
const assert = require('node:assert/strict');
const { parseApps } = require('./software');

const app = (over) => ({ DisplayName: 'App', PSPath: 'Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\X', ...over });

test('hides system components, updates, sub-entries and nameless keys', () => {
  const raw = [
    app({ DisplayName: 'Shown' }),
    app({ DisplayName: 'System', SystemComponent: 1 }),
    app({ DisplayName: 'Child', ParentKeyName: 'Parent' }),
    app({ DisplayName: 'Patch', ReleaseType: 'Security Update' }),
    app({ DisplayName: '   ' }),
    app({ DisplayName: undefined }),
    null,
  ];
  assert.deepEqual(parseApps(raw).map((a) => a.name), ['Shown']);
});

test('normalises date, size, key and missing fields', () => {
  const [a] = parseApps([app({ InstallDate: 20260519, EstimatedSize: 2048, Publisher: '' })]);
  assert.equal(a.installDate, '2026-05-19');
  assert.equal(a.sizeBytes, 2048 * 1024);
  assert.equal(a.key, 'HKEY_LOCAL_MACHINE\\SOFTWARE\\X');
  assert.equal(a.publisher, null);
  assert.equal(a.version, null);
});

test('bad dates and sizes become null', () => {
  const [a] = parseApps([app({ InstallDate: '5/19/2026', EstimatedSize: 0 })]);
  assert.equal(a.installDate, null);
  assert.equal(a.sizeBytes, null);
});

test('accepts a single object, null and empty input; sorts by name ignoring case', () => {
  assert.equal(parseApps(app({ DisplayName: 'One' })).length, 1);
  assert.deepEqual(parseApps(null), []);
  assert.deepEqual(parseApps([]), []);
  assert.deepEqual(parseApps([app({ DisplayName: 'beta' }), app({ DisplayName: 'Alpha' })]).map((a) => a.name), ['Alpha', 'beta']);
});
