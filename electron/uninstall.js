const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { findApp } = require('./software');
const { withLock } = require('./lock');

// Runs the app's own uninstaller; deletes nothing by itself. The window names an app by its registry key; the command
// line comes from that app's own registry entry here, never from the window.

const GUID = /\{[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}/;

const expandEnv = (s) => s.replace(/%([^%]+)%/g, (m, name) => process.env[Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())] ?? m);

// Splits '"C:\Program Files\X\unins000.exe" /SILENT' or 'C:\Program Files\X\uninst.exe -x' into program and arguments.
function splitCommand(cmd) {
  const s = expandEnv(String(cmd ?? '').trim());
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end < 0 ? null : { exe: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  const m = /^(.+?\.exe)(?=\s|$)(.*)$/i.exec(s); // unquoted paths may contain spaces: the program ends at the first ".exe"
  return m ? { exe: m[1], args: m[2].trim() } : null;
}

function planUninstall(app) {
  const cmd = app.quietUninstallString || app.uninstallString;
  if (!cmd) throw new Error('This app does not say how to uninstall it.');
  const elevate = app.scope === 'machine'; // all-users apps need administrator permission: Windows asks, we don't bypass it
  if (/\bmsiexec(\.exe)?\b/i.test(cmd)) {
    const guid = GUID.exec(cmd)?.[0] ?? GUID.exec(app.key.split('\\').pop())?.[0];
    if (!guid) throw new Error("Could not find this app's Windows Installer product code.");
    return { kind: 'msi', exe: 'msiexec.exe', args: `/x ${guid} /qb /norestart`, elevate, productCode: guid };
  }
  const parts = splitCommand(cmd);
  if (!parts) throw new Error("Could not understand this app's uninstall command.");
  if (!path.isAbsolute(parts.exe) || !fs.existsSync(parts.exe)) throw new Error(`The uninstaller is missing: ${parts.exe}`);
  return { kind: 'exe', exe: parts.exe, args: parts.args, elevate, productCode: null };
}

// Program, arguments and key reach PowerShell as environment variables, never pasted into the script.
const RUN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if ($env:WB_ELEVATE -eq '1') {
    # ProcessStartInfo, not Start-Process: a declined prompt then surfaces as a Win32Exception carrying the code 1223
    # (Start-Process throws a plain InvalidOperationException with no code)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:WB_EXE
    if ($env:WB_ARGS) { $psi.Arguments = $env:WB_ARGS }
    $psi.Verb = 'runas'
    $psi.UseShellExecute = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
  } else {
    $a = @{ FilePath = $env:WB_EXE; Wait = $true; PassThru = $true }
    if ($env:WB_ARGS) { $a.ArgumentList = $env:WB_ARGS }
    $p = Start-Process @a
  }
  'EXIT=' + $p.ExitCode
} catch {
  $e = $_.Exception
  while ($e.InnerException -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }
  if ($e -is [System.ComponentModel.Win32Exception]) { 'CODE=' + $e.NativeErrorCode }
  'ERROR=' + $_.Exception.Message
  exit 2
}
`;
const EXISTS_SCRIPT = `Test-Path -LiteralPath ('Registry::' + $env:WB_KEY)`;

const ps = (script, env, timeout) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 1024 * 1024 });

const keyExists = async (key) => (await ps(EXISTS_SCRIPT, { WB_KEY: key }, 20000)).stdout.trim() === 'True';

// How long to wait, after the uninstaller exits, for the app's registry entry to disappear.
// Windows Installer exit codes are reliable: a failure code means nothing was removed, so there is nothing to wait for.
// Other uninstallers (NSIS, Inno...) often hand over to a copy of themselves and exit at once, and may show a wizard that a
// person clicks through, so they get several minutes.
const waitMs = (kind, code) => (kind !== 'msi' ? 5 * 60 * 1000 : code === 0 || code === 3010 ? 90 * 1000 : 0);

const snapshots = new Map(); // key -> what the app looked like before it was removed; the leftover scan uses this
const getSnapshot = (key) => snapshots.get(key);

async function uninstallApp(key) {
  return withLock(async () => {
    const app = findApp(key);
    if (!app) throw new Error('The software list is out of date. Refresh it and try again.');
    const plan = planUninstall(app);
    snapshots.set(key, { key, name: app.name, publisher: app.publisher, version: app.version, location: app.location, productCode: plan.productCode, scope: app.scope, takenAt: Date.now() });

    let out;
    try {
      out = (await ps(RUN_SCRIPT, { WB_EXE: plan.exe, WB_ARGS: plan.args, WB_ELEVATE: plan.elevate ? '1' : '0' }, 20 * 60 * 1000)).stdout;
    } catch (e) {
      out = String(e.stdout || '');
      if (!/CODE=|EXIT=/.test(out)) throw new Error(`Could not start the uninstaller. ${String(e.stderr || e.message).split('\n')[0]}`);
    }
    const exitCode = /EXIT=(-?\d+)/.exec(out)?.[1];
    const cancelled = /CODE=1223\b/.test(out); // the Windows permission prompt was declined
    if (cancelled) return { name: app.name, removed: false, cancelled: true, exitCode: null, message: 'The Windows permission prompt was declined, so nothing changed.' };
    if (exitCode === undefined) return { name: app.name, removed: false, cancelled: false, exitCode: null, message: (/ERROR=(.*)/.exec(out)?.[1] || 'The uninstaller could not be started.').trim() };

    // Many installers hand the work to another process and exit at once, so the exit code is not enough: wait for the entry to go.
    const code = Number(exitCode);
    let removed = !(await keyExists(key));
    for (let waited = 0; !removed && waited < waitMs(plan.kind, code); waited += 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      removed = !(await keyExists(key));
    }
    return {
      name: app.name,
      removed,
      cancelled: code === 1602, // MSI: the user cancelled inside the installer
      exitCode: code,
      message: removed ? (code === 3010 ? 'Removed. Windows asks for a restart to finish.' : null) : code === 1602 ? 'The uninstall was cancelled, so nothing changed.' : `The uninstaller finished (code ${code}) but the app is still listed.`,
    };
  });
}

module.exports = { uninstallApp, getSnapshot, planUninstall, splitCommand, waitMs, RUN_SCRIPT };
