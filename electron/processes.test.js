const test = require('node:test');
const assert = require('node:assert/strict');
const { groupProcesses, whyNotEnd, isProtected } = require('./processes');

test('groups processes by name, summing memory and CPU', () => {
  const [chrome, other] = groupProcesses([
    { pid: 1, name: 'chrome', cpuPct: 1.5, mem: 100, title: null },
    { pid: 2, name: 'Chrome', cpuPct: 2, mem: 50, title: 'Tab' },
    { pid: 3, name: 'notepad', cpuPct: null, mem: 10, title: null },
  ]);
  assert.deepEqual(chrome.pids, [1, 2]);
  assert.equal(chrome.memBytes, 150);
  assert.equal(chrome.cpu, 3.5);
  assert.equal(chrome.title, 'Tab');
  assert.equal(other.cpu, null);
});

test('marks Windows core processes and this app as protected', () => {
  assert.ok(isProtected('svchost'));
  assert.ok(isProtected('LSASS'));
  assert.ok(!isProtected('chrome'));
  assert.equal(groupProcesses([{ pid: 4, name: 'csrss', cpuPct: null, mem: 1 }])[0].protected, true);
});

test('refuses bad, unknown, protected and own pids', () => {
  const known = new Map([[10, 'chrome'], [11, 'lsass']]);
  assert.equal(whyNotEnd(10, known), null);
  assert.match(whyNotEnd(11, known), /Protected/);
  assert.match(whyNotEnd(999, known), /out of date/);
  assert.match(whyNotEnd(-1, known), /Invalid/);
  assert.match(whyNotEnd('10', known), /Invalid/);
  assert.match(whyNotEnd(process.pid, new Map([[process.pid, 'x']])), /Webase/);
});
