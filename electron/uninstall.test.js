const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { splitCommand, planUninstall, waitMs, RUN_SCRIPT } = require('./uninstall');

// The launcher script, run for real but without any Windows permission prompt: a launch that fails at once.
const runScript = (env) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RUN_SCRIPT], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });

test('the launcher reports the Windows error code of a failed elevated launch (a declined prompt is code 1223 the same way)', () => {
  let out = '';
  try {
    out = runScript({ WB_EXE: 'C:\\definitely-not-here\\nothing.exe', WB_ARGS: '', WB_ELEVATE: '1' });
  } catch (e) {
    out = String(e.stdout);
  }
  assert.match(out, /CODE=2\b/, 'file not found is Windows error 2; before the fix this printed an empty code');
  assert.match(out, /ERROR=/);
});

test('the launcher still runs a normal, non-elevated program and reports its exit code', () => {
  assert.match(runScript({ WB_EXE: process.env.ComSpec, WB_ARGS: '/c exit 7', WB_ELEVATE: '0' }), /EXIT=7\b/);
});

const GUID = '{12345678-ABCD-4EF0-8123-456789ABCDEF}';
const app = (over) => ({ key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\X', scope: 'machine', uninstallString: null, quietUninstallString: null, windowsInstaller: false, ...over });

test('splits a quoted command line', () => {
  assert.deepEqual(splitCommand('"C:\\Program Files\\App\\unins000.exe" /SILENT /NORESTART'), { exe: 'C:\\Program Files\\App\\unins000.exe', args: '/SILENT /NORESTART' });
  assert.deepEqual(splitCommand('"C:\\x\\u.exe"'), { exe: 'C:\\x\\u.exe', args: '' });
});

test('splits an unquoted command line whose path contains spaces: the program ends at the first .exe', () => {
  assert.deepEqual(splitCommand('C:\\Program Files\\App\\uninst.exe -uninstall -q'), { exe: 'C:\\Program Files\\App\\uninst.exe', args: '-uninstall -q' });
  assert.deepEqual(splitCommand('C:\\a\\b.exe'), { exe: 'C:\\a\\b.exe', args: '' });
});

test('expands environment variables and refuses lines it cannot read', () => {
  process.env.WB_TEST_DIR = 'C:\\Tools';
  assert.equal(splitCommand('%WB_TEST_DIR%\\u.exe /S').exe, 'C:\\Tools\\u.exe');
  assert.equal(splitCommand('"unterminated'), null);
  assert.equal(splitCommand('no program here'), null);
  assert.equal(splitCommand(''), null);
  assert.equal(splitCommand(null), null);
});

test('a Windows Installer app is removed by product code, whichever of /I or /X its entry uses', () => {
  for (const cmd of [`MsiExec.exe /X${GUID}`, `msiexec.exe /I${GUID}`, `"C:\\Windows\\System32\\msiexec.exe" /x ${GUID} /qn`]) {
    const plan = planUninstall(app({ uninstallString: cmd }));
    assert.equal(plan.kind, 'msi');
    assert.equal(plan.exe, 'msiexec.exe');
    assert.equal(plan.args, `/x ${GUID} /qb /norestart`);
    assert.equal(plan.productCode, GUID);
    assert.equal(plan.elevate, true);
  }
});

test('the product code can come from the registry key name when the command line has none', () => {
  const plan = planUninstall(app({ key: `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`, uninstallString: 'msiexec.exe /x' }));
  assert.equal(plan.productCode, GUID);
  assert.throws(() => planUninstall(app({ uninstallString: 'msiexec.exe /x' })), /product code/);
});

test('a quiet command is preferred; only all-users apps ask for administrator permission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-uninst-test-'));
  const exe = path.join(dir, 'unins000.exe');
  fs.writeFileSync(exe, '');
  try {
    const plan = planUninstall(app({ scope: 'user', uninstallString: `"${exe}"`, quietUninstallString: `"${exe}" /VERYSILENT` }));
    assert.deepEqual([plan.kind, plan.exe, plan.args, plan.elevate], ['exe', exe, '/VERYSILENT', false]);
    assert.equal(planUninstall(app({ scope: 'machine', uninstallString: `"${exe}"` })).elevate, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('how long to wait for the registry entry to disappear depends on the kind of uninstaller', () => {
  assert.equal(waitMs('msi', 0), 90000);
  assert.equal(waitMs('msi', 3010), 90000); // success, restart needed
  assert.equal(waitMs('msi', 1602), 0); // cancelled: nothing more will happen
  assert.equal(waitMs('msi', 1603), 0); // fatal error
  assert.equal(waitMs('exe', 0), 300000); // may hand over to a copy of itself, and a person may be clicking through its wizard
  assert.equal(waitMs('exe', 1), 300000); // other uninstallers can exit early or oddly
});

test('refuses an app with no uninstall command, an unreadable one, or a missing uninstaller', () => {
  assert.throws(() => planUninstall(app({})), /does not say how/);
  assert.throws(() => planUninstall(app({ uninstallString: 'nonsense' })), /Could not understand/);
  assert.throws(() => planUninstall(app({ uninstallString: '"C:\\definitely\\not\\here\\u.exe"' })), /missing/);
  assert.throws(() => planUninstall(app({ uninstallString: 'u.exe' })), /missing/); // a bare name is not trusted to resolve to the right program
});
