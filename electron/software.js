const fs = require('fs');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// Same three places Windows' own "Apps" lists read from.
const SCRIPT = String.raw`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
$apps = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
  Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, EstimatedSize, InstallLocation,
    SystemComponent, ParentKeyName, ReleaseType, PSPath, UninstallString, QuietUninstallString, WindowsInstaller
ConvertTo-Json -InputObject @($apps) -Compress
`;

const UPDATE_TYPES = new Set(['Security Update', 'Update Rollup', 'Hotfix', 'Update']);

// shortcut: no de-duplication; the same app in two hives is listed twice, upgrade if that confuses users.
function parseApps(raw) {
  return [].concat(raw ?? [])
    .filter((a) => String(a?.DisplayName ?? '').trim()
      && a.SystemComponent !== 1 && !a.ParentKeyName && !UPDATE_TYPES.has(a.ReleaseType))
    .map((a) => {
      const date = String(a.InstallDate ?? '');
      const key = String(a.PSPath ?? '').replace(/^.*Registry::/, '');
      return {
        key,
        scope: /^HKEY_CURRENT_USER/i.test(key) ? 'user' : 'machine',
        uninstallString: a.UninstallString || null,
        quietUninstallString: a.QuietUninstallString || null,
        windowsInstaller: a.WindowsInstaller === 1,
        name: String(a.DisplayName).trim(),
        version: a.DisplayVersion || null,
        publisher: a.Publisher || null,
        installDate: /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : null,
        sizeBytes: a.EstimatedSize > 0 ? a.EstimatedSize * 1024 : null, // registry stores KB
        location: a.InstallLocation || null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

let last = []; // the window asks to open a folder by registry key, never by path

function folderOf(key) {
  const app = last.find((a) => a.key === key);
  const dir = app?.location?.replace(/^"|"$/g, '');
  if (!dir) return { error: 'No install folder is recorded for this app' };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: 'That folder no longer exists' };
  return { dir };
}

const findApp = (key) => last.find((a) => a.key === key);

// What the window sees: no uninstall command lines, only whether an uninstall is possible.
const publicApp = ({ uninstallString, quietUninstallString, windowsInstaller, ...app }) => ({ ...app, canUninstall: !!(uninstallString || quietUninstallString) });

async function listSoftware() {
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
  });
  last = parseApps(JSON.parse(stdout.replace(/^﻿/, '')));
  return last.map(publicApp);
}

module.exports = { listSoftware, parseApps, folderOf, findApp };
