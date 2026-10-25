const os = require('os');
const path = require('path');
const { runScript } = require('./leftover-admin');
const { scanDriverUpdates } = require('./drivers');

// Installs ONE driver update that Windows Update offers, and only one that the latest scan listed (the window sends its id).
// Everything risky happens in one elevated step behind one Windows permission prompt:
//   search again -> exactly that update (id AND revision) -> it must be a driver, not hidden, license already accepted, and not able to
//   ask questions -> make a System Restore point and PROVE it is new (its sequence number is higher than before) -> download -> install.
// If any of that fails nothing is installed. Afterwards this process searches again on its own to see whether Windows still offers it.

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PROMPT_MS = 3 * 60 * 1000; // how long the permission prompt may wait before the step refuses to run
const RUN_MS = 60 * 60 * 1000; // how long a download and install may take before this app stops watching

const INSTALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__JOB__')) | ConvertFrom-Json
# The person was told it failed if the prompt was answered late: do nothing.
if ($job.notAfter -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [int64]$job.notAfter) { exit 3 }
Set-Content -LiteralPath ([string]$job.resultFile + '.started') -Value 'started' -Encoding ASCII
$out = [ordered]@{ status = 'failed'; message = $null; restorePoint = $null; resultCode = $null; hresult = $null; rebootRequired = $false; removedTestPoint = $null }
function Finish { ConvertTo-Json -InputObject ([pscustomobject]$out) -Compress | Set-Content -LiteralPath ([string]$job.resultFile) -Encoding UTF8; exit 0 }
function Fail($status, $message) { $out.status = $status; $out.message = $message; Finish }

# A restore point is only believed if one with this exact name and a HIGHER sequence number than before now exists. A throttled
# Checkpoint-Computer only warns and creates nothing, so the warning is turned into an error too.
function New-VerifiedRestorePoint($description) {
  $before = 0
  try { $max = (Get-ComputerRestorePoint | Measure-Object SequenceNumber -Maximum).Maximum; if ($max) { $before = [int]$max } } catch { }
  Checkpoint-Computer -Description $description -RestorePointType DEVICE_DRIVER_INSTALL -WarningAction Stop
  Start-Sleep -Seconds 3
  $rp = Get-ComputerRestorePoint | Where-Object { $_.Description -eq $description -and [int]$_.SequenceNumber -gt $before } | Select-Object -First 1
  if (-not $rp) { throw 'Windows did not report a new restore point.' }
  return $rp
}

try {
  $description = [string]$job.description
  if ($description -notmatch '^Webase (before driver update|test) \d{8}-\d{6}$') { Fail 'refused' 'The restore point name is not valid.' }

  if ($job.mode -eq 'restore-point-test') {
    # Test only: make a point, prove it, then remove exactly that one again (srclient.dll SRRemoveRestorePoint).
    try { $rp = New-VerifiedRestorePoint $description } catch { Fail 'no-restore-point' ('No restore point could be made. ' + $_.Exception.Message) }
    $out.restorePoint = [ordered]@{ sequence = [int]$rp.SequenceNumber; description = $description }
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class WebaseSR { [DllImport("srclient.dll")] public static extern int SRRemoveRestorePoint(int dwRPNum); }'
    $rc = [WebaseSR]::SRRemoveRestorePoint([int]$rp.SequenceNumber)
    Start-Sleep -Seconds 3
    $still = @(Get-ComputerRestorePoint | Where-Object { [int]$_.SequenceNumber -eq [int]$rp.SequenceNumber }).Count
    $out.removedTestPoint = ($still -eq 0)
    $out.resultCode = $rc
    $out.status = 'restore-point-ok'
    Finish
  }

  $session = New-Object -ComObject Microsoft.Update.Session
  $found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Driver'")
  $u = $null
  foreach ($x in $found.Updates) { if ($x.Identity.UpdateID -eq [string]$job.id -and [int]$x.Identity.RevisionNumber -eq [int]$job.revision) { $u = $x } }
  if (-not $u) { Fail 'gone' 'Windows Update does not offer this driver any more, so nothing was changed.' }
  if ([int]$u.Type -ne 2) { Fail 'refused' 'This update is not a driver, so it was not installed.' }
  if ($u.IsHidden) { Fail 'refused' 'This update is hidden in Windows Update, so it was not installed.' }
  if (-not $u.EulaAccepted) { Fail 'refused' 'This driver needs its license terms accepted first. Accept them in Windows Update settings; this app does not accept licenses for you.' }
  if ($u.InstallationBehavior.CanRequestUserInput) { Fail 'refused' 'This driver installer may ask questions, which cannot be answered here. Install it from Windows Update settings.' }

  try { $rp = New-VerifiedRestorePoint $description } catch { Fail 'no-restore-point' ('No restore point could be made, so nothing was installed. ' + $_.Exception.Message) }
  $out.restorePoint = [ordered]@{ sequence = [int]$rp.SequenceNumber; description = $description }

  $coll = New-Object -ComObject Microsoft.Update.UpdateColl
  [void]$coll.Add($u)
  $dl = $session.CreateUpdateDownloader()
  $dl.Updates = $coll
  $dr = $dl.Download()
  if ([int]$dr.ResultCode -ne 2) { $out.resultCode = [int]$dr.ResultCode; $out.hresult = [int]$dr.HResult; Fail 'download-failed' 'Windows Update could not download the driver, so nothing was installed.' }

  $inst = $session.CreateUpdateInstaller()
  $inst.Updates = $coll
  $inst.AllowSourcePrompts = $false
  $ir = $inst.Install()
  $out.resultCode = [int]$ir.ResultCode
  $out.hresult = [int]$ir.HResult
  $out.rebootRequired = [bool]$ir.RebootRequired
  if ($out.resultCode -eq 2) { $out.status = 'installed' }
  elseif ($out.resultCode -eq 3) { $out.status = 'installed-with-errors' }
  else { $out.status = 'install-failed' }
  Finish
} catch {
  Fail 'failed' $_.Exception.Message
}
`;

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261025-130000

const TEXT = {
  installed: 'The driver was installed.',
  'installed-with-errors': 'The driver was installed, but Windows reported errors. Check Windows Update history.',
  'install-failed': 'Windows could not install the driver. A restore point was made first; nothing needs undoing.',
};

let maybeRunningUntil = 0; // a run this app stopped watching may still be going: no second install until then

async function installDriverUpdate({ id, revision }, d = {}) {
  if (!GUID.test(String(id))) throw new Error('That is not a valid update id.');
  if (!Number.isInteger(revision) || revision < 0 || revision > 1e9) throw new Error('That is not a valid update revision.');
  const now = d.now ?? Date.now();
  if (now < maybeRunningUntil) throw new Error('A driver install started earlier may still be running. Check Windows Update history, and restart if it asks, before trying again.');
  const run = d.run ?? runScript;
  const search = d.search ?? scanDriverUpdates;

  const job = { mode: 'install', id, revision, description: `Webase before driver update ${stamp(now)}`, resultFile: path.join(os.tmpdir(), `webase-driver-${stamp(now)}.json`) };
  let r;
  try {
    r = await run(INSTALL_SCRIPT, job, { timeoutMs: RUN_MS, deadlineMs: PROMPT_MS, tooBig: 'The driver request is too large.' });
  } catch (e) {
    if (e.code === 'DECLINED') return { id, status: 'declined', message: 'The Windows permission prompt was declined, so nothing changed.', rebootRequired: false, restorePoint: null, stillOffered: null };
    if (e.code === 'TIMEOUT') return { id, status: 'not-answered', message: e.message, rebootRequired: false, restorePoint: null, stillOffered: null };
    if (e.code === 'STILL_RUNNING') {
      maybeRunningUntil = now + RUN_MS;
      return { id, status: 'still-running', message: e.message, rebootRequired: false, restorePoint: null, stillOffered: null };
    }
    throw e;
  }

  const installed = r.status === 'installed' || r.status === 'installed-with-errors';
  let stillOffered = null; // checked from here, not taken on the script's word
  if (installed) {
    try {
      stillOffered = (await search()).updates.some((u) => String(u.id).toLowerCase() === String(id).toLowerCase());
    } catch {
      stillOffered = null;
    }
  }
  const message = r.message || TEXT[r.status] || 'The driver was not installed.';
  return {
    id,
    status: r.status,
    message: installed && stillOffered ? `${message} Windows Update still lists it; it may need a restart to finish.` : message,
    rebootRequired: !!r.rebootRequired,
    restorePoint: r.restorePoint ?? null,
    stillOffered,
  };
}

// Used only by the tests that run on this PC: makes one restore point, proves it, removes it again.
async function restorePointSelfTest(d = {}) {
  const now = d.now ?? Date.now();
  const job = { mode: 'restore-point-test', description: `Webase test ${stamp(now)}`, resultFile: path.join(os.tmpdir(), `webase-driver-test-${stamp(now)}.json`) };
  return (d.run ?? runScript)(INSTALL_SCRIPT, job, { elevate: d.elevate ?? true, timeoutMs: 10 * 60 * 1000, deadlineMs: PROMPT_MS });
}

module.exports = { installDriverUpdate, restorePointSelfTest, INSTALL_SCRIPT, GUID, PROMPT_MS, RUN_MS, _resetBusy: () => { maybeRunningUntil = 0; } };
