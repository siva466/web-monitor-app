const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('./log');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webase-log-test-')), 'logs');
const at = () => new Date(Date.UTC(2026, 9, 25, 13, 0, 0));

test('nothing is created until something is logged', () => {
  const dir = tmp();
  createLogger({ dir, now: at });
  assert.ok(!fs.existsSync(dir), 'a healthy run leaves no log folder');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a line has the time, the kind, where it happened and the message, on one line', () => {
  const dir = tmp();
  const log = createLogger({ dir, now: at });
  log.error('sw:uninstall', new Error('The uninstaller is missing:\n  C:\\x\\u.exe'));
  log.crash('render-process-gone', 'crashed (code 5)');
  const lines = fs.readFileSync(log.file, 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines, ['2026-10-25T13:00:00.000Z ERROR sw:uninstall: The uninstaller is missing: C:\\x\\u.exe', '2026-10-25T13:00:00.000Z CRASH render-process-gone: crashed (code 5)']);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a very long message is cut, and the file rotates once to app.old.log at the size limit', () => {
  const dir = tmp();
  const log = createLogger({ dir, now: at, maxBytes: 1000 });
  log.error('x', 'a'.repeat(5000));
  assert.ok(fs.readFileSync(log.file, 'utf8').length < 700, 'cut to a line of reasonable length');
  for (let i = 0; i < 4; i++) log.error('y', `entry ${i} ${'b'.repeat(300)}`);
  assert.ok(fs.existsSync(path.join(dir, 'app.old.log')), 'the full file moved aside');
  assert.ok(fs.statSync(log.file).size <= 1000, 'the current file stays under the limit');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['app.log', 'app.old.log'], 'only one old file is kept');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('logging never throws, even when the folder cannot be created', () => {
  const log = createLogger({ dir: path.join(os.tmpdir(), 'webase-log-test-nul', 'bad\0name') });
  assert.doesNotThrow(() => log.error('x', new Error('boom')));
  assert.doesNotThrow(() => createLogger({ dir: 'relative\\path' }).error('x', 'y'));
});
