const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// "Why did Windows block this?" Reads what Windows kept in its Code Integrity log, and says it in plain words. Read-only: it never changes
// Smart App Control, never unblocks or allows anything. It reads the NAMED FIELDS of each event, not the message text (that is in the
// system language), and it never takes a file path from the window.

// Signing levels as Windows numbers them (the ones that appear in this log). Anything else is shown as "level N".
const LEVELS = { 0: 'unchecked', 1: 'unsigned', 2: 'Enterprise', 3: 'Developer', 4: 'Authenticode', 6: 'Store', 7: 'Antimalware', 8: 'Microsoft', 11: 'dynamic code', 12: 'Windows', 14: 'Windows TCB' };
const levelName = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : LEVELS[n] ?? `level ${n}`);

const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// One event as the XML Windows gives (Event.ToXml()): id, time, activity id and every <Data Name='..'>value</Data> field.
function parseEvent(xml) {
  const id = Number(/<EventID[^>]*>(\d+)<\/EventID>/.exec(xml)?.[1]);
  const time = /<TimeCreated SystemTime=['"]([^'"]+)['"]/.exec(xml)?.[1] ?? null;
  const activity = (/<Correlation ActivityID=['"]\{?([0-9a-fA-F-]+)\}?['"]/.exec(xml)?.[1] ?? '').toLowerCase() || null;
  const data = {};
  for (const m of xml.matchAll(/<Data Name=(?:'([^']*)'|"([^"]*)")(?:\/>|>([\s\S]*?)<\/Data>)/g)) data[m[1] ?? m[2]] = decode(m[3] ?? '');
  if (!id || !time) return null;
  return { id, time, activity, data };
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = /^0x/i.test(String(v)) ? parseInt(v, 16) : Number(v);
  return Number.isNaN(n) ? null : n;
};
const pick = (d, ...names) => names.map((n) => d[n]).find((v) => v !== undefined && v !== '') ?? null;

// \Device\HarddiskVolume3\Windows\x.dll -> C:\Windows\x.dll (volumes: { C: '\Device\HarddiskVolume3', ... })
function fromDevicePath(p, volumes) {
  if (!p) return null;
  const m = /^(\\Device\\[^\\]+)(\\.*)?$/i.exec(p);
  if (!m) return p;
  const letter = Object.entries(volumes ?? {}).find(([, dev]) => dev.toLowerCase() === m[1].toLowerCase())?.[0];
  return letter ? `${letter}:${m[2] ?? '\\'}` : p;
}
const baseName = (p) => (p ? p.split('\\').filter(Boolean).pop() ?? p : null);

// The Smart App Control state Windows keeps in the registry: 1 = on, 2 = evaluation mode, 0 = off.
function sacState(v) {
  if (v === 1) return { state: 'on', label: 'On', text: 'Smart App Control is on: Windows blocks apps it cannot confirm are safe.' };
  if (v === 2) return { state: 'evaluation', label: 'Evaluating', text: 'Smart App Control is learning (evaluation mode): it is not blocking yet.' };
  if (v === 0) return { state: 'off', label: 'Off', text: 'Smart App Control is off.' };
  return { state: 'unknown', label: 'Unknown', text: 'Windows did not say whether Smart App Control is on.' };
}

// events: parsed events (3033, 3076, 3077 and the 3089 signature companions). One row per blocked file and loading program.
function buildRows(events, volumes) {
  const sig = new Map(); // activity id -> { publisher, issuer } from the 3089 companion
  // Windows logs the word "Unknown" as the publisher of an unsigned file: that is not a company name
  const realName = (v) => (v && !/^unknown$/i.test(v.trim()) ? v : null);
  for (const e of events) if (e.id === 3089 && e.activity) sig.set(e.activity, { publisher: realName(pick(e.data, 'PublisherName')), issuer: realName(pick(e.data, 'IssuerName')) });

  const groups = new Map();
  for (const e of events) {
    if (![3033, 3076, 3077].includes(e.id)) continue;
    const d = e.data;
    const file = fromDevicePath(pick(d, 'File Name', 'FileNameBuffer'), volumes);
    const process = fromDevicePath(pick(d, 'Process Name', 'ProcessNameBuffer'), volumes);
    if (!file) continue;
    const key = `${file.toLowerCase()}|${(process ?? '').toLowerCase()}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { file, process, events: [] }));
    g.events.push({ e, d });
  }

  const rows = [];
  for (const g of groups.values()) {
    const has = (id) => g.events.some((x) => x.e.id === id);
    const kind = has(3077) ? 'policy' : has(3076) ? 'audit' : 'signing-level';
    const main = g.events.filter((x) => x.e.id === (kind === 'policy' ? 3077 : kind === 'audit' ? 3076 : 3033));
    const times = main.map((x) => Date.parse(x.e.time)).sort((a, b) => a - b);
    const last = main.reduce((a, b) => (Date.parse(b.e.time) >= Date.parse(a.e.time) ? b : a));
    const d = last.d;
    const publisher = g.events.map((x) => sig.get(x.e.activity)?.publisher).find(Boolean) ?? null;
    const requested = num(pick(d, 'Requested Signing Level', 'RequestedPolicy'));
    const validated = num(pick(d, 'Validated Signing Level', 'ValidatedPolicy'));
    const policy = pick(d, 'PolicyName');
    rows.push({
      file: g.file,
      fileName: baseName(g.file),
      process: g.process,
      processName: baseName(g.process),
      kind,
      count: main.length,
      first: new Date(times[0]).toISOString(),
      last: new Date(times[times.length - 1]).toISOString(),
      needed: levelName(requested),
      got: kind === 'signing-level' ? null : levelName(validated), // for a Microsoft-only check, "validated 1" says nothing about the file's own signature
      policy,
      product: pick(d, 'ProductName'),
      description: pick(d, 'FileDescription'),
      company: null,
      version: pick(d, 'FileVersion'),
      publisher,
      signature: null,
      reason: '',
    });
  }
  rows.sort((a, b) => b.last.localeCompare(a.last));
  return rows;
}

// The plain-words reason, after file details are known
function reasonOf(r) {
  const who = r.processName ?? 'A program';
  const what = r.fileName ?? 'a file';
  const by = r.publisher ? ` It is signed by ${r.publisher}.` : r.signer ? ` It is signed by ${r.signer}.` : '';
  if (r.kind === 'policy') {
    const pol = r.policy ? ` (policy "${r.policy}"${/^VerifiedAndReputable/i.test(r.policy) ? ', named like the policy Smart App Control uses' : ''})` : '';
    return `Windows' app control blocked ${what}${pol} because it is not signed at the level required${r.needed ? ` (${r.needed}${r.got ? `; this file counted as ${r.got}` : ''})` : ''} or Windows does not know it as safe. ${who} tried to start or load it.`;
  }
  if (r.kind === 'audit') return `Windows would block ${what} (audit only: it was recorded, not blocked). ${who} tried to start or load it.`;
  // a program that only loads files signed by Microsoft (or Windows, the Store, an antimalware vendor) refuses everything else
  if (STRICT.includes(r.needed)) return `${who} only accepts files signed by ${r.needed}, and refused ${what}.${by} The file itself may be fine: a program with this rule refuses everything from other publishers.`;
  return `${who} requires files signed at the ${r.needed ?? 'required'} level, and ${what} did not meet that.${by}`;
}
const STRICT = ['Microsoft', 'Windows', 'Windows TCB', 'Store', 'Antimalware'];

const FETCH_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System.Text; using System.Runtime.InteropServices; public static class WebaseDos { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint QueryDosDevice(string d, StringBuilder t, uint n); }'
$vol = [ordered]@{}
foreach ($c in [char[]]'CDEFGHIJKLMNOPQRSTUVWXYZ') { $sb = New-Object System.Text.StringBuilder 520; if ([WebaseDos]::QueryDosDevice(('' + $c + ':'), $sb, 520) -gt 0) { $vol[[string]$c] = $sb.ToString() } }
$log = 'Microsoft-Windows-CodeIntegrity/Operational'
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = $log; Id = 3033, 3076, 3077, 3089 } -MaxEvents 1500 | ForEach-Object { $_.ToXml() })
$oldest = (Get-WinEvent -LogName $log -Oldest -MaxEvents 1).TimeCreated
$sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
ConvertTo-Json -InputObject ([pscustomobject]@{ volumes = $vol; events = $ev; oldest = $(if ($oldest) { $oldest.ToUniversalTime().ToString('o') } else { $null }); sac = $sac }) -Compress -Depth 4
`;

// What a blocked file is, when it still exists: version details and whether its signature is valid. Read-only.
const LOOKUP_SCRIPT = String.raw`
$files = $env:WB_FILES | ConvertFrom-Json
if ($files -isnot [array]) { $files = @($files) } # not @(...) around the pipeline: Windows PowerShell 5.1 would nest the array
$out = foreach ($f in $files) {
  $item = Get-Item -LiteralPath $f -ErrorAction SilentlyContinue
  if (-not $item -or $item.PSIsContainer) { [pscustomobject]@{ file = $f; exists = $false }; continue }
  $v = $item.VersionInfo
  $s = Get-AuthenticodeSignature -LiteralPath $f -ErrorAction SilentlyContinue
  [pscustomobject]@{ file = $f; exists = $true; product = $v.ProductName; description = $v.FileDescription; company = $v.CompanyName; version = $v.FileVersion; status = [string]$s.Status; signer = $(if ($s.SignerCertificate) { (($s.SignerCertificate.Subject -split ',')[0]) -replace '^CN=', '' } else { $null }) }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

// The same log, but only what was recorded since a moment (milliseconds since 1970): used to explain an install or update that just failed.
const RECENT_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition 'using System.Text; using System.Runtime.InteropServices; public static class WebaseDos { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint QueryDosDevice(string d, StringBuilder t, uint n); }'
$vol = [ordered]@{}
foreach ($c in [char[]]'CDEFGHIJKLMNOPQRSTUVWXYZ') { $sb = New-Object System.Text.StringBuilder 520; if ([WebaseDos]::QueryDosDevice(('' + $c + ':'), $sb, 520) -gt 0) { $vol[[string]$c] = $sb.ToString() } }
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:WB_SINCE).LocalDateTime
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; Id = 3033, 3076, 3077, 3089; StartTime = $since } | ForEach-Object { $_.ToXml() })
ConvertTo-Json -InputObject ([pscustomobject]@{ volumes = $vol; events = $ev }) -Compress -Depth 4
`;

const ps = (script, env, timeout) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const parseJson = (stdout) => JSON.parse(stdout.replace(/^﻿/, '').trim() || 'null');

const MAX_LOOKUPS = 40;

const defaults = () => ({
  fetch: async () => parseJson((await ps(FETCH_SCRIPT, {}, 90000)).stdout),
  lookup: async (files) => (files.length ? [].concat(parseJson((await ps(LOOKUP_SCRIPT, { WB_FILES: JSON.stringify(files) }, 90000)).stdout) ?? []) : []),
});

async function listBlocked(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const raw = await d.fetch();
  const events = (raw?.events ?? []).map(parseEvent).filter(Boolean);
  const rows = buildRows(events, raw?.volumes ?? {});

  // file details, for distinct files that exist, newest first, capped; only paths that came from the log and map to a drive letter
  const want = rows.filter((r) => /^[A-Za-z]:\\/.test(r.file)).slice(0, MAX_LOOKUPS).map((r) => r.file);
  const found = new Map((await d.lookup([...new Set(want)]).catch(() => [])).map((f) => [f.file.toLowerCase(), f]));
  for (const r of rows) {
    const f = found.get(r.file.toLowerCase());
    r.exists = f ? f.exists : null;
    if (f?.exists) {
      r.product = r.product || f.product || null;
      r.description = r.description || f.description || null;
      r.company = f.company || null;
      r.version = r.version || f.version || null;
      r.signature = f.status === 'Valid' ? 'valid' : f.status === 'NotSigned' ? 'unsigned' : f.status ? 'not valid' : null;
      r.signer = f.signer || null;
    }
    r.reason = reasonOf(r);
  }
  return {
    sac: sacState(raw?.sac === undefined || raw?.sac === null ? null : Number(raw.sac)),
    rows,
    eventCount: events.filter((e) => [3033, 3076, 3077].includes(e.id)).length,
    oldest: raw?.oldest ?? null,
    checkedAt: Date.now(),
  };
}

// Files Windows' app control (Smart App Control or a policy) blocked since `sinceMs`, newest first. Audit-only records and "this program only
// loads Microsoft-signed files" refusals are not blocks of an installer and are left out.
async function recentBlocks(sinceMs, overrides = {}) {
  const d = { recent: async (s) => parseJson((await ps(RECENT_SCRIPT, { WB_SINCE: String(Math.floor(s)) }, 30000)).stdout), ...overrides };
  const raw = await d.recent(sinceMs);
  return buildRows((raw?.events ?? []).map(parseEvent).filter(Boolean), raw?.volumes ?? {}).filter((r) => r.kind === 'policy');
}

// The sentence for an install or update that failed while Windows was blocking a file (null when nothing was blocked).
function blockedMessage(rows) {
  if (!rows?.length) return null;
  const r = rows[0];
  const sac = /^VerifiedAndReputable/i.test(r.policy ?? '');
  const what = rows.length === 1 ? `${r.fileName ?? 'a file'}${r.processName ? ` (loaded by ${r.processName})` : ''}` : `${rows.length} files, the newest ${r.fileName ?? 'a file'}${r.processName ? ` (loaded by ${r.processName})` : ''}`;
  return `While this ran, ${sac ? 'Smart App Control' : "Windows' app control"} blocked ${what} because Windows cannot confirm who published it. That is probably why it stopped. The program itself may be fine: its installer carries a helper file Windows does not trust. The Blocked page shows the details, and this app never changes Smart App Control. A zip or per-user version from the publisher may not be blocked.`;
}

// `fallback` is what the install or update said itself; a block that happened while it ran is the better explanation. A failure to read the log
// never hides the original message.
async function explainFailure(startedAtMs, fallback, deps = {}) {
  try {
    return blockedMessage(await (deps.recentBlocks ?? recentBlocks)(startedAtMs - 3000)) ?? fallback;
  } catch {
    return fallback;
  }
}

module.exports = { listBlocked, recentBlocks, blockedMessage, explainFailure, parseEvent, buildRows, reasonOf, fromDevicePath, levelName, sacState, FETCH_SCRIPT, RECENT_SCRIPT, LOOKUP_SCRIPT, MAX_LOOKUPS };
