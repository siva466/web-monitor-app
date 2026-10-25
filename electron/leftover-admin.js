const fs = require('fs');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// The one place this app asks for administrator rights, and only for two kinds of leftover: an EMPTY folder in an all-users
// place (Program Files, ProgramData...), and a key under HKLM\SOFTWARE (exported to a .reg file first). Windows asks the user
// once for the whole batch. The list was already checked by the caller; the script checks the shape of every item again, and
// that a folder is really empty and not a link, because it runs with full rights.

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__JOB__')) | ConvertFrom-Json
# The app stops waiting after a while. If the permission prompt is answered after that, do nothing: the person has been told it failed.
if ($job.notAfter -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [int64]$job.notAfter) { exit 3 }
function Under($p, $roots) {
  foreach ($r in $roots) {
    $root = $r.TrimEnd('\') + '\'
    if ($p.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and $p.Length -gt $root.Length) { return $true }
  }
  return $false
}
$results = foreach ($i in $job.items) {
  $r = [ordered]@{ id = [string]$i.id; ok = $false; error = $null }
  try {
    if ($i.kind -eq 'registry') {
      $p = [string]$i.path
      $own = ($job.ownKey -and $p -eq $job.ownKey -and $p -match '^HKEY_LOCAL_MACHINE\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^\\]+$')
      if (-not $own) {
        if ($p -notmatch '^HKEY_LOCAL_MACHINE\\SOFTWARE\\(WOW6432Node\\)?([^\\]+)(\\[^\\]+)*$') { throw 'It is not a key this helper handles.' }
        if ($Matches[2] -in 'Microsoft', 'Classes', 'Policies', 'Windows') { throw 'It is a Windows or shared location.' }
      }
      $k = Get-Item -LiteralPath ('Registry::' + $p) -ErrorAction SilentlyContinue
      if ($k) {
        if ($i.requireEmpty -and ($k.SubKeyCount -gt 0 -or $k.ValueCount -gt 0)) { throw 'It is not empty, so it may belong to other apps.' }
        if (([string]$i.backup) -notmatch '\.reg$') { throw 'No valid backup file was given, so it was not removed.' }
        & reg.exe export $p ([string]$i.backup) /y | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath ([string]$i.backup)) -or (Get-Item -LiteralPath ([string]$i.backup)).Length -eq 0) { throw 'It could not be backed up, so it was not removed.' }
        & reg.exe delete $p /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Windows could not remove it.' }
      }
    } else {
      $p = [string]$i.path
      # a plain absolute path: no "." or ".." parts, no forward or doubled slashes, so "inside the roots" means what it says
      if ($p -notmatch '^[A-Za-z]:\\' -or $p -match '[/]|\\\\|(^|\\)\.{1,2}(\\|$)' -or -not (Under $p $job.roots)) { throw 'It is outside the folders this helper handles.' }
      $f = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
      if ($f) {
        if (-not $f.PSIsContainer) { throw 'Only an empty folder is removed here.' }
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'It is a link, which is never followed.' }
        $up = [IO.Path]::GetDirectoryName($p)
        while ($up -and (Under $up $job.roots)) {
          if ((Get-Item -LiteralPath $up -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A folder above it is a link, which is never followed.' }
          $up = [IO.Path]::GetDirectoryName($up)
        }
        if ((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -gt 0) { throw 'It is not empty. Use File Explorer.' }
        [IO.Directory]::Delete($p, $false) # not recursive: fails if anything appeared meanwhile
      }
    }
    $r.ok = $true
  } catch {
    $r.error = $_.Exception.Message
  }
  [pscustomobject]$r
}
ConvertTo-Json -InputObject @($results) -Compress | Set-Content -LiteralPath ([string]$job.resultFile) -Encoding UTF8
`;

const LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
try {
  # ProcessStartInfo, not Start-Process: a declined prompt then surfaces as a Win32Exception carrying the code 1223
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = '-NoProfile -EncodedCommand ' + $env:WB_ENC
  $psi.Verb = 'runas'
  $psi.UseShellExecute = $true
  $psi.WindowStyle = 'Hidden'
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  'EXIT=' + $p.ExitCode
} catch {
  $e = $_.Exception
  while ($e.InnerException -and -not ($e -is [System.ComponentModel.Win32Exception])) { $e = $e.InnerException }
  if ($e -is [System.ComponentModel.Win32Exception]) { 'CODE=' + $e.NativeErrorCode }
  'ERROR=' + $_.Exception.Message
  exit 2
}
`;

// Runs a script template (with __JOB__ in it) elevated behind ONE Windows permission prompt, and returns what it wrote to job.resultFile.
// Two clocks: deadlineMs is how long the prompt may wait before the script refuses to run (its "notAfter"); timeoutMs is how long the
// app waits for the whole run before it stops watching. A script that has started writes <resultFile>.started right after its expiry
// check, so a give-up after that is reported as "still running", not as "left as it is".
// With elevate:false the same script runs without the permission prompt (used by the tests, on throwaway data).
async function runScript(template, job, { elevate = true, timeoutMs = 5 * 60 * 1000, deadlineMs = timeoutMs, tooBig = 'Too many all-users items at once. Remove them in smaller groups.' } = {}) {
  const script = template.replace('__JOB__', Buffer.from(JSON.stringify({ ...job, notAfter: job.notAfter ?? Date.now() + deadlineMs }), 'utf8').toString('base64'));
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length > 30000) throw new Error(tooBig);
  const started = `${job.resultFile}.started`;
  for (const f of [job.resultFile, started]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // none left over from an earlier run
    }
  }

  if (elevate) {
    let out = '';
    try {
      out = (await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LAUNCHER], { env: { ...process.env, WB_ENC: encoded }, timeout: timeoutMs, windowsHide: true })).stdout;
    } catch (e) {
      out = String(e.stdout || '');
      // The app stops waiting but the Windows prompt stays on screen until someone answers it (seen live). The job's expiry makes a
      // late "Yes" do nothing, and this message says what to do with the prompt.
      if (e.killed && fs.existsSync(started)) throw Object.assign(new Error('The administrator step started but has not finished, and may still be running. Check Windows Update history before trying again.'), { code: 'STILL_RUNNING' });
      if (e.killed) throw Object.assign(new Error('The Windows permission prompt was not answered in time, so this was left as it is. If the prompt is still showing, choose No.'), { code: 'TIMEOUT' });
      if (!/CODE=|EXIT=/.test(out)) throw new Error(`Could not start the administrator step. ${String(e.stderr || e.message).split('\n')[0].slice(0, 160)}`);
    }
    if (/CODE=1223\b/.test(out)) throw Object.assign(new Error('The Windows permission prompt was declined, so nothing changed.'), { code: 'DECLINED' });
    if (!/EXIT=/.test(out)) throw new Error((/ERROR=(.*)/.exec(out)?.[1] || 'The administrator step could not be started.').trim());
  } else {
    // the result file, not the exit code, says what happened (and a failure would otherwise print the whole encoded script)
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: timeoutMs, windowsHide: true }).catch(() => {});
  }

  let text;
  try {
    text = fs.readFileSync(job.resultFile, 'utf8').replace(/^﻿/, '');
    fs.unlinkSync(job.resultFile);
    fs.rmSync(started, { force: true });
  } catch {
    throw new Error('The administrator step did not report back.');
  }
  return JSON.parse(text);
}

// job: { items: [{ id, kind: 'registry'|'folder', path, backup?, requireEmpty? }], roots: [...], ownKey, resultFile }
// Returns one result per item: { id, ok, error }.
async function runElevated(job, opts = {}) {
  if (job.items.length > 50) throw new Error('Too many all-users items at once. Remove them in smaller groups.');
  return [].concat((await runScript(HELPER, job, opts)) ?? []);
}

module.exports = { runElevated, runScript, HELPER };
