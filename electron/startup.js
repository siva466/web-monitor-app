const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

const BASE = 'Software\\Microsoft\\Windows\\CurrentVersion';
const approvedKey = (hive, leaf) => `${hive}:\\${BASE}\\Explorer\\StartupApproved\\${leaf}`;

// Where Windows keeps startup entries, and the "StartupApproved" key that holds each one's on/off flag.
// Task Manager's Startup apps tab reads and writes the same flags, so changes here show up there.
const SOURCES = [
  { scope: 'user', source: 'run', kind: 'registry', path: `HKCU:\\${BASE}\\Run`, approved: approvedKey('HKCU', 'Run') },
  { scope: 'machine', source: 'run', kind: 'registry', path: `HKLM:\\${BASE}\\Run`, approved: approvedKey('HKLM', 'Run') },
  { scope: 'machine', source: 'run32', kind: 'registry', path: `HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run`, approved: approvedKey('HKLM', 'Run32') },
  { scope: 'user', source: 'folder', kind: 'folder', path: 'Startup', approved: approvedKey('HKCU', 'StartupFolder') },
  { scope: 'machine', source: 'folder', kind: 'folder', path: 'CommonStartup', approved: approvedKey('HKLM', 'StartupFolder') },
];

const LIST_SCRIPT = String.raw`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$sources = $env:WB_SOURCES | ConvertFrom-Json
function Flag($approved, $name) {
  $k = Get-Item -LiteralPath $approved -ErrorAction SilentlyContinue
  if ($k) { $b = $k.GetValue($name); if ($b -is [byte[]] -and $b.Length) { return [int]$b[0] } }
  return $null
}
$items = foreach ($s in $sources) {
  if ($s.kind -eq 'registry') {
    $k = Get-Item -LiteralPath $s.path -ErrorAction SilentlyContinue
    if (-not $k) { continue }
    foreach ($n in $k.GetValueNames()) {
      if (-not $n) { continue }
      [pscustomobject]@{ scope = $s.scope; source = $s.source; name = $n; command = [string]$k.GetValue($n); flag = (Flag $s.approved $n) }
    }
  } else {
    $dir = [Environment]::GetFolderPath($s.path)
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue) {
      if ($f.Name -eq 'desktop.ini') { continue }
      [pscustomobject]@{ scope = $s.scope; source = $s.source; name = $f.Name; command = $f.FullName; flag = (Flag $s.approved $f.Name) }
    }
  }
}
ConvertTo-Json -InputObject @($items) -Compress
`;

// Enabled = 02 (or 06); disabled = 03 (or 07) followed by the time it was switched off. No flag at all means enabled.
const WRITE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$key = $env:WB_KEY
if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
if ($env:WB_ENABLE -eq '1') { $bytes = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0) }
else { $bytes = [byte[]](3,0,0,0) + [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc()) }
New-ItemProperty -LiteralPath $key -Name $env:WB_NAME -Value $bytes -PropertyType Binary -Force | Out-Null
`;

function parseStartup(raw) {
  return [].concat(raw ?? [])
    .filter((e) => e && e.name)
    .map((e) => ({
      id: `${e.scope}|${e.source}|${e.name}`,
      name: e.source === 'folder' ? e.name.replace(/\.(lnk|url)$/i, '') : e.name,
      valueName: e.name,
      command: e.command || '',
      scope: e.scope,
      source: e.source,
      enabled: !(Number.isInteger(e.flag) && e.flag & 1),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const run = (script, env) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
  });

let last = []; // the window changes an entry by id; the registry path and name come from here, never from the window

async function listStartup() {
  const { stdout } = await run(LIST_SCRIPT, { WB_SOURCES: JSON.stringify(SOURCES) });
  return (last = parseStartup(JSON.parse(stdout.replace(/^﻿/, ''))));
}

async function setStartup(id, enabled) {
  if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid request.');
  const entry = last.find((e) => e.id === id);
  if (!entry) throw new Error('The startup list is out of date. Refresh and try again.');
  const src = SOURCES.find((s) => s.scope === entry.scope && s.source === entry.source);
  try {
    await run(WRITE_SCRIPT, { WB_KEY: src.approved, WB_NAME: entry.valueName, WB_ENABLE: enabled ? '1' : '0' });
  } catch (e) {
    const detail = String(e.stderr || e.message);
    throw new Error(/denied|not allowed|Unauthorized|Security/i.test(detail) ? 'Needs administrator rights to change entries for all users.' : `Could not change the setting. ${detail.split('\n')[0]}`);
  }
  const list = await listStartup();
  if (list.find((e) => e.id === id)?.enabled !== enabled) throw new Error('Windows did not accept the change.');
  return list;
}

module.exports = { listStartup, setStartup, parseStartup, SOURCES };
