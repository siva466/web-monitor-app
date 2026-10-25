const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installDriverUpdate, INSTALL_SCRIPT, GUID, PROMPT_MS, RUN_MS, _resetBusy } = require('./driver-install');
const { runScript } = require('./leftover-admin');
const { parseUpdates } = require('./drivers');

const ID = '3f2a1c9e-8b7d-4e6f-a1b2-c3d4e5f60718';
const NOW = Date.UTC(2026, 9, 25, 13, 0, 0);
const deps = (res, over = {}) => ({ now: NOW, run: async (script, job, opts) => { deps.last = { script, job, opts }; if (res instanceof Error) throw res; return res; }, search: async () => ({ updates: [] }), ...over });
const err = (code, message) => Object.assign(new Error(message), { code });

test.beforeEach(() => _resetBusy());

test('the update id and revision are checked before anything is run', async () => {
  for (const bad of ['', 'x', `${ID}; calc`, '{3f2a1c9e-8b7d-4e6f-a1b2-c3d4e5f60718}', null, undefined, 42]) {
    await assert.rejects(() => installDriverUpdate({ id: bad, revision: 1 }, deps({})), /not a valid update id/);
  }
  for (const bad of [-1, 1.5, '3', null, 2e9]) await assert.rejects(() => installDriverUpdate({ id: ID, revision: bad }, deps({})), /not a valid update revision/);
  assert.ok(GUID.test(ID));
});

test('the step is handed a short prompt deadline, a long run time, a restore point name and a temp result file', async () => {
  const d = deps({ status: 'installed', rebootRequired: false });
  await installDriverUpdate({ id: ID, revision: 201 }, d);
  const { job, opts, script } = deps.last;
  assert.equal(script, INSTALL_SCRIPT);
  assert.deepEqual([job.mode, job.id, job.revision], ['install', ID, 201]);
  assert.match(job.description, /^Webase before driver update \d{8}-\d{6}$/);
  assert.equal(job.description, 'Webase before driver update 20261025-130000');
  assert.ok(path.resolve(job.resultFile).startsWith(os.tmpdir()));
  assert.equal(opts.deadlineMs, PROMPT_MS);
  assert.equal(opts.timeoutMs, RUN_MS);
  assert.ok(PROMPT_MS <= 5 * 60 * 1000 && RUN_MS >= 30 * 60 * 1000, 'the prompt may wait minutes, the install up to an hour');
});

test('an install is checked from here afterwards: gone from the list is good, still listed is said so', async () => {
  const ok = await installDriverUpdate({ id: ID, revision: 201 }, deps({ status: 'installed', rebootRequired: true, restorePoint: { sequence: 7, description: 'Webase before driver update 20261025-130000' } }, { search: async () => ({ updates: [{ id: 'other' }] }) }));
  assert.deepEqual([ok.status, ok.stillOffered, ok.rebootRequired, ok.message], ['installed', false, true, 'The driver was installed.']);
  assert.equal(ok.restorePoint.sequence, 7);

  _resetBusy();
  const still = await installDriverUpdate({ id: ID, revision: 201 }, deps({ status: 'installed' }, { search: async () => ({ updates: [{ id: ID.toUpperCase() }] }) }));
  assert.equal(still.stillOffered, true);
  assert.match(still.message, /still lists it/);

  _resetBusy();
  const unknown = await installDriverUpdate({ id: ID, revision: 201 }, deps({ status: 'installed-with-errors' }, { search: async () => { throw new Error('offline'); } }));
  assert.equal(unknown.stillOffered, null);
  assert.match(unknown.message, /reported errors/);
});

test('when nothing was installed, nothing is verified and the reason is passed on', async () => {
  for (const [status, message] of [['gone', 'Windows Update does not offer this driver any more, so nothing was changed.'], ['refused', 'This driver needs its license terms accepted first.'], ['no-restore-point', 'No restore point could be made, so nothing was installed.'], ['download-failed', 'Windows Update could not download the driver.'], ['install-failed', null]]) {
    _resetBusy();
    let searched = false;
    const r = await installDriverUpdate({ id: ID, revision: 201 }, deps({ status, message }, { search: async () => { searched = true; return { updates: [] }; } }));
    assert.equal(r.status, status);
    assert.equal(searched, false, `${status}: no re-search`);
    assert.ok(r.message.length > 10, status);
  }
});

test('a declined or unanswered prompt is reported plainly; an install that may still be running blocks a second one', async () => {
  const declined = await installDriverUpdate({ id: ID, revision: 1 }, deps(err('DECLINED', 'x')));
  assert.deepEqual([declined.status, declined.message], ['declined', 'The Windows permission prompt was declined, so nothing changed.']);
  const slow = await installDriverUpdate({ id: ID, revision: 1 }, deps(err('TIMEOUT', 'not answered in time')));
  assert.equal(slow.status, 'not-answered');
  assert.match(slow.message, /not answered in time/);

  const running = await installDriverUpdate({ id: ID, revision: 1 }, deps(err('STILL_RUNNING', 'may still be running')));
  assert.equal(running.status, 'still-running');
  await assert.rejects(() => installDriverUpdate({ id: ID, revision: 1 }, deps({ status: 'installed' }, { now: NOW + 10 * 60 * 1000 })), /may still be running/);
  const later = await installDriverUpdate({ id: ID, revision: 1 }, deps({ status: 'installed' }, { now: NOW + RUN_MS + 1000 }));
  assert.equal(later.status, 'installed', 'allowed again after an hour');

  _resetBusy();
  await assert.rejects(() => installDriverUpdate({ id: ID, revision: 1 }, deps(new Error('Could not start the administrator step.'))), /Could not start/);
});

test('the script never accepts a license and puts exactly one update into the install list', () => {
  assert.doesNotMatch(INSTALL_SCRIPT, /AcceptEula/i);
  assert.equal((INSTALL_SCRIPT.match(/\.Add\(/g) ?? []).length, 1);
  for (const guard of ['EulaAccepted', 'CanRequestUserInput', 'IsHidden', 'RevisionNumber', 'UpdateID', "-RestorePointType DEVICE_DRIVER_INSTALL", '-WarningAction Stop', '-gt $before']) assert.ok(INSTALL_SCRIPT.includes(guard), guard);
  assert.ok(INSTALL_SCRIPT.lastIndexOf('New-VerifiedRestorePoint $description }') < INSTALL_SCRIPT.indexOf('$dl.Download()'), 'the restore point of the real install comes before the download');
  assert.ok(INSTALL_SCRIPT.lastIndexOf('New-VerifiedRestorePoint $description }') > INSTALL_SCRIPT.indexOf('EulaAccepted'), 'and only after every guard');
  assert.ok(INSTALL_SCRIPT.indexOf('$dl.Download()') < INSTALL_SCRIPT.indexOf('$inst.Install()'));
});

// The real script, run WITHOUT elevation and without touching Windows Update: it must stop at its own checks.
const jobFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webase-dinst-test-')), name);

test('the real script refuses a restore point name that is not ours, and does nothing at all when its deadline has passed', async () => {
  const bad = jobFile('r.json');
  const r = await runScript(INSTALL_SCRIPT, { mode: 'install', id: ID, revision: 1, description: 'Delete everything', resultFile: bad }, { elevate: false });
  assert.equal(r.status, 'refused');
  assert.match(r.message, /restore point name/);
  assert.ok(!fs.existsSync(`${bad}.started`), 'the marker is cleaned up after a normal finish');

  const late = jobFile('late.json');
  await assert.rejects(() => runScript(INSTALL_SCRIPT, { mode: 'install', id: ID, revision: 1, description: 'Webase test 20261025-130000', resultFile: late, notAfter: Date.now() - 1000 }, { elevate: false }), /did not report back/);
  assert.ok(!fs.existsSync(`${late}.started`), 'an expired run does not even start');

  const testMode = jobFile('t.json');
  const t = await runScript(INSTALL_SCRIPT, { mode: 'restore-point-test', description: 'not ours', resultFile: testMode }, { elevate: false });
  assert.equal(t.status, 'refused', 'the test mode has the same name check');
});

test('update rows carry a validated id and revision; an update without a real id cannot be installed', () => {
  const [a, b, c] = parseUpdates([
    { title: 'A', id: ID.toUpperCase(), revision: 201 },
    { title: 'B', id: 'not-a-guid', revision: 1 },
    { title: 'C', id: ID, revision: -3 },
  ]);
  assert.deepEqual([a.id, a.revision], [ID, 201]);
  assert.deepEqual([b.id, b.revision], [null, 1]);
  assert.deepEqual([c.id, c.revision], [ID, null]);
});
