const fs = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { backupRoot, whyRegistryRefused, whyFileRefused, inAllUsersPlace } = require('./leftover-delete');
const { defaultRoots, registryExists } = require('./leftovers');
const { parseReg, decodeReg, encodeReg, MAX_BYTES } = require('./reg-file');
const { runScript } = require('./leftover-admin');

// What the app removed, and putting it back. The window names a backup by its folder name and an item by its number in the manifest;
// everything else (paths, files, keys) is resolved here, under the backup folder, and links are never followed.

const BACKUP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[\p{L}\p{N}-]{1,60}$/u;
const MAX_BACKUPS = 100;
const PROMPT_MS = 3 * 60 * 1000;
const NEAR_MS = 30 * 60 * 1000; // a Recycle Bin entry deleted this close to the removal is taken as the one

// ---- reading the system (each one is replaceable in tests) -------------------------------------------------------------------

// Recycle Bin entries with these names: where each was deleted from and when. The shell's own properties, not column text.
const BIN_LIST_SCRIPT = String.raw`
$names = $env:WB_NAMES | ConvertFrom-Json
if ($names -isnot [array]) { $names = @($names) } # not @(...) around the pipeline: Windows PowerShell 5.1 would nest the array
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$out = foreach ($i in $bin.Items()) {
  if ($names -contains $i.Name) {
    $when = $i.ExtendedProperty('System.Recycle.DateDeleted')
    [pscustomobject]@{ name = $i.Name; from = [string]$i.ExtendedProperty('System.Recycle.DeletedFrom'); deleted = $(if ($when) { ([datetime]$when).ToUniversalTime().ToString('o') } else { $null }); isFolder = [bool]$i.IsFolder; binPath = [string]$i.Path }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`;
const UNDELETE_SCRIPT = String.raw`
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$hit = @($bin.Items() | Where-Object { $_.Path -eq $env:WB_BINPATH })
if ($hit.Count -ne 1) { 'NOTFOUND'; exit 0 }
$hit[0].InvokeVerb('undelete')
Start-Sleep -Seconds 2
'DONE'
`;
// What a key holds now: for the check after a restore (values by name, and data for strings and numbers)
const READ_SCRIPT = String.raw`
$keys = $env:WB_KEYS | ConvertFrom-Json
if ($keys -isnot [array]) { $keys = @($keys) } # see the note in the Recycle Bin script
$out = foreach ($k in $keys) {
  $item = Get-Item -LiteralPath ('Registry::' + $k) -ErrorAction SilentlyContinue
  if (-not $item) { [pscustomobject]@{ key = $k; exists = $false; values = @() }; continue }
  $vals = foreach ($n in $item.GetValueNames()) {
    $kind = $item.GetValueKind($n).ToString()
    $v = $item.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    $data = $null
    if ($kind -eq 'String') { $data = [string]$v } elseif ($kind -eq 'DWord') { $data = [int64][BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$v), 0) }
    [pscustomobject]@{ name = $n; kind = $kind; data = $data }
  }
  [pscustomobject]@{ key = $k; exists = $true; values = @($vals) }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 5
`;

const ps = (script, env, timeout = 60000) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const parseJson = (stdout) => [].concat(JSON.parse(stdout.replace(/^﻿/, '').trim() || '[]'));

const defaults = () => ({
  backupRoot: backupRoot(),
  roots: defaultRoots(),
  tmpDir: os.tmpdir(),
  now: Date.now(),
  run: runScript,
  readBin: async (names) => parseJson((await ps(BIN_LIST_SCRIPT, { WB_NAMES: JSON.stringify(names) })).stdout),
  undelete: async (binPath) => (await ps(UNDELETE_SCRIPT, { WB_BINPATH: binPath })).stdout.trim(),
  keysNow: async (keys) => (keys.length ? registryExists(keys) : []), // [{ key, subkeys, values }] for those that exist
  readBack: async (keys) => parseJson((await ps(READ_SCRIPT, { WB_KEYS: JSON.stringify(keys) })).stdout),
  importKey: (file) => execFile('reg.exe', ['import', file], { windowsHide: true }),
});

// ---- locating a backup safely ------------------------------------------------------------------------------------------------

async function resolveBackup(id, root) {
  if (typeof id !== 'string' || !BACKUP_ID.test(id)) throw new Error('That is not a backup this app made.');
  const dir = path.join(root, id);
  if (path.dirname(dir) !== path.resolve(root) && path.dirname(dir) !== root) throw new Error('That is not a backup this app made.');
  let st;
  try {
    st = await fs.lstat(dir);
  } catch {
    throw new Error('That backup is not there any more. Refresh the list.');
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('That is not a backup this app made.');
  return dir;
}

async function readManifest(dir) {
  try {
    const full = path.join(dir, 'manifest.json');
    const st = await fs.lstat(full);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) return null;
    const m = JSON.parse(await fs.readFile(full, 'utf8'));
    return m && Array.isArray(m.results) ? m : null;
  } catch {
    return null;
  }
}

// The .reg file for a key: named in the manifest (format 2), or found by its key line (older backups)
async function regFileFor(dir, item) {
  if (typeof item.backupFile === 'string') {
    if (path.basename(item.backupFile) !== item.backupFile || !/\.reg$/i.test(item.backupFile)) return null;
    return item.backupFile;
  }
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => /\.reg$/i.test(f));
  } catch {
    return null;
  }
  for (const f of names) {
    try {
      const st = await fs.lstat(path.join(dir, f));
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) continue;
      const text = decodeReg(await fs.readFile(path.join(dir, f)));
      if (text.split(/\r?\n/).some((l) => l.toLowerCase() === `[${item.path}]`.toLowerCase())) return f;
    } catch {
      // unreadable: not this one
    }
  }
  return null;
}

async function readRegBackup(dir, item) {
  const file = await regFileFor(dir, item);
  if (!file) return { error: 'The .reg file for this key is missing.' };
  const full = path.join(dir, file);
  let st;
  try {
    st = await fs.lstat(full);
  } catch {
    return { error: 'The .reg file for this key is missing.' };
  }
  if (!st.isFile() || st.isSymbolicLink()) return { error: 'The .reg file is not a plain file, so it is not used.' };
  if (st.size > MAX_BYTES) return { error: 'The backup file is too big to restore from here. Double-click the .reg file in File Explorer instead.' };
  const text = decodeReg(await fs.readFile(full));
  const why = whyRegistryRefused(item.path, item.path);
  if (why) return { error: why };
  const parsed = parseReg(text, { target: item.path });
  if (!parsed.ok) return { error: `${parsed.reason} Double-click the .reg file in File Explorer only if you trust it.` };
  return { file, text, parsed };
}

const leaf = (p) => path.basename(p);
const parentOf = (p) => path.dirname(p);
// In the Recycle Bin a file may be listed without its extension (the Explorer setting that hides it), so both spellings are looked for
const binNames = (item) => (item.kind === 'file' ? [...new Set([leaf(item.path), path.parse(item.path).name])] : [leaf(item.path)]);
const isBinItem = (r) => r.kind === 'folder' || r.kind === 'file';

// ---- the list ----------------------------------------------------------------------------------------------------------------

async function listBackups(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  let names = [];
  try {
    names = (await fs.readdir(d.backupRoot, { withFileTypes: true })).filter((e) => e.isDirectory() && BACKUP_ID.test(e.name)).map((e) => e.name);
  } catch {
    return { backups: [], checkedAt: d.now };
  }
  names.sort().reverse(); // the timestamp is the start of the name
  const rows = [];
  for (const id of names.slice(0, MAX_BACKUPS)) {
    const dir = path.join(d.backupRoot, id);
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const manifest = await readManifest(dir);
    const items = [];
    for (const [index, r] of (manifest?.results ?? []).entries()) {
      if (!r || r.ok !== true || typeof r.path !== 'string' || (r.kind !== 'registry' && !isBinItem(r))) continue;
      if (r.kind === 'registry') {
        const read = await readRegBackup(dir, r);
        items.push({ index, kind: 'registry', path: r.path, how: 'reg-export', canRestore: !read.error, why: read.error ?? null, state: '' });
      } else {
        // a file is only ever moved to the Recycle Bin; only a folder can have been an empty all-users folder
        const how = r.kind === 'file' ? 'recycle-bin' : r.method === 'admin-empty-folder' || r.method === 'recycle-bin' ? r.method : inAllUsersPlace(r.path) ? 'admin-empty-folder' : 'recycle-bin';
        items.push({ index, kind: r.kind, path: r.path, how, canRestore: false, why: how === 'admin-empty-folder' ? 'It was an empty folder, so it held nothing to restore.' : null, state: '' });
      }
    }
    rows.push({ id, when: manifest?.when ?? null, app: manifest?.app ?? null, publisher: manifest?.publisher ?? null, readable: !!manifest, items });
  }

  // current state, asked once for all backups: which keys exist now, which folders are in the Recycle Bin or back in place
  const keys = rows.flatMap((r) => r.items.filter((i) => i.kind === 'registry').map((i) => i.path));
  const alive = new Map((await d.keysNow([...new Set(keys)]).catch(() => [])).map((k) => [k.key.toLowerCase(), k]));
  const folders = rows.flatMap((r) => r.items.filter((i) => i.kind !== 'registry' && i.how === 'recycle-bin').map((i) => ({ row: r, item: i })));
  let bin = [];
  if (folders.length) bin = await d.readBin([...new Set(folders.flatMap((f) => binNames(f.item)))]).catch(() => null);
  for (const r of rows) {
    for (const i of r.items) {
      if (i.kind === 'registry') {
        const k = alive.get(i.path.toLowerCase());
        i.state = k ? `The key exists now (${k.values} value${k.values === 1 ? '' : 's'}, ${k.subkeys} subkey${k.subkeys === 1 ? '' : 's'}). Restoring overwrites values with the same name.` : 'The key is gone.';
      } else if (i.how === 'recycle-bin') {
        const exists = await fs.lstat(i.path).then(() => true, () => false);
        if (exists) { i.state = `A ${i.kind} with this name exists again, so it is not put back.`; i.canRestore = false; i.why = i.state; }
        else if (bin === null) { i.state = 'The Recycle Bin could not be read.'; i.why = i.state; }
        else {
          const hit = pickBinEntry(bin, i.path, r.when ? Date.parse(r.when) : null, i.kind);
          i.state = hit.entry ? 'In the Recycle Bin.' : hit.ambiguous ? 'Several entries with this name are in the Recycle Bin; restore it there.' : 'No longer in the Recycle Bin.';
          i.canRestore = !!hit.entry && !whyFileRefused(i.path, d.roots) && !inAllUsersPlace(i.path);
          i.why = i.canRestore ? null : hit.entry ? 'This is not a place the app restores into.' : i.state;
        }
      } else i.state = 'Held nothing.';
    }
  }
  return { backups: rows, checkedAt: d.now };
}

// Among the Recycle Bin entries with this name that were deleted from this folder, the one deleted nearest to the removal.
function pickBinEntry(bin, itemPath, whenMs, kind = 'folder') {
  const from = parentOf(itemPath).toLowerCase();
  const names = binNames({ kind, path: itemPath }).map((n) => n.toLowerCase());
  const found = bin.filter((b) => b.isFolder === (kind !== 'file') && names.includes(String(b.name).toLowerCase()) && String(b.from).toLowerCase() === from);
  if (!found.length) return { entry: null, ambiguous: false };
  if (found.length === 1) return { entry: found[0], ambiguous: false };
  const near = found.filter((b) => b.deleted && whenMs != null).map((b) => ({ b, gap: Math.abs(Date.parse(b.deleted) - whenMs) })).sort((a, b) => a.gap - b.gap);
  if (near.length && near[0].gap <= NEAR_MS && (near.length === 1 || near[1].gap - near[0].gap > 60 * 1000)) return { entry: near[0].b, ambiguous: false };
  return { entry: null, ambiguous: true };
}

// ---- restoring a registry key ------------------------------------------------------------------------------------------------

const RESTORE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__JOB__')) | ConvertFrom-Json
# The person was told it failed if the prompt was answered late: do nothing.
if ($job.notAfter -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [int64]$job.notAfter) { exit 3 }
Set-Content -LiteralPath ([string]$job.resultFile + '.started') -Value 'started' -Encoding ASCII
$out = [ordered]@{ status = 'failed'; message = $null }
function Finish { ConvertTo-Json -InputObject ([pscustomobject]$out) -Compress | Set-Content -LiteralPath ([string]$job.resultFile) -Encoding UTF8; exit 0 }
function Fail($status, $message) { $out.status = $status; $out.message = $message; Finish }
try {
  $m = [string]$job.key
  $own = $m -match '^HKEY_LOCAL_MACHINE\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^\\]+$'
  if (-not $own) {
    if ($m -notmatch '^HKEY_LOCAL_MACHINE\\SOFTWARE\\(WOW6432Node\\)?([^\\]+)(\\[^\\]+)*$') { Fail 'refused' 'It is not a key this step restores.' }
    if ($Matches[2] -in 'Microsoft', 'Classes', 'Policies', 'Windows') { Fail 'refused' 'It is a Windows or shared location.' }
  }
  # the saved text arrives inside this request (compressed), never as a path to a file a program could change
  $ms = New-Object IO.MemoryStream (, [Convert]::FromBase64String([string]$job.reg))
  $text = (New-Object IO.StreamReader (New-Object IO.Compression.GZipStream ($ms, [IO.Compression.CompressionMode]::Decompress)), [Text.Encoding]::UTF8).ReadToEnd()
  if ($text.Length -gt 40000) { Fail 'refused' 'The backup is too big to restore with this step.' }

  # check it again here: only shapes reg export writes, only the target key and below, nothing that deletes
  $name = '(@|"(?:[^"\\]|\\.)*")'
  $str = '"(?:[^"\\]|\\.)*"'
  $hex = 'hex(?:\([0-9a-fA-F]{1,2}\))?:(?:[0-9a-fA-F]{2}(?:,[0-9a-fA-F]{2})*)?'
  $valueRe = '^' + $name + '=(' + $str + '|dword:[0-9a-fA-F]{8}|' + $hex + ')$'
  $hexStart = '^' + $name + '=hex(?:\([0-9a-fA-F]{1,2}\))?:[0-9a-fA-F,\s]*\\$'
  $raw = [regex]::Split($text, '\r?\n')
  $lines = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $raw.Length; $i++) {
    $line = $raw[$i] -replace '[ \t]+$', ''
    if ($line -match $hexStart) { while ($line.EndsWith('\') -and $i + 1 -lt $raw.Length) { $i++; $line = $line.Substring(0, $line.Length - 1) + $raw[$i].Trim() } }
    $lines.Add(($line -replace '\s+$', ''))
  }
  $first = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -ne '') { $first = $i; break } }
  if ($first -lt 0 -or $lines[$first] -ne 'Windows Registry Editor Version 5.00') { Fail 'refused' 'This is not a registry export of the expected kind.' }
  $key = $null; $sawTarget = $false
  for ($i = $first + 1; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -eq '' -or $line.StartsWith(';')) { continue }
    if ($line -match '^\[([^\]]+)\]$') {
      $k = $Matches[1]
      if ($k.StartsWith('-')) { Fail 'refused' 'The file would delete a key.' }
      if (-not ($k.Equals($m, 'OrdinalIgnoreCase') -or $k.StartsWith($m + '\', 'OrdinalIgnoreCase'))) { Fail 'refused' 'The file touches a key other than the one that was backed up.' }
      if ($k.Equals($m, 'OrdinalIgnoreCase')) { $sawTarget = $true }
      $key = $k
      continue
    }
    if ($null -eq $key -or $line -notmatch $valueRe) { Fail 'refused' 'A line is not in a form this step restores.' }
  }
  if (-not $sawTarget) { Fail 'refused' 'The backup does not contain the key it is for.' }

  # A new file in the Windows temp folder (a normal program cannot change a file it did not create). It is written and closed, then
  # held open READ-ONLY with writes by others denied while reg.exe imports it, and checked to be exactly what was written first.
  # (Found live: a write handle left open makes reg.exe fail with "Error opening the file".)
  $file = Join-Path (Join-Path $env:SystemRoot 'Temp') ('webase-restore-' + [guid]::NewGuid().ToString('N') + '.reg')
  $bytes = [byte[]](0xFF, 0xFE) + [Text.Encoding]::Unicode.GetBytes($text)
  $ro = $null
  try {
    $w = New-Object IO.FileStream ($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $w.Write($bytes, 0, $bytes.Length) } finally { $w.Dispose() }
    $ro = New-Object IO.FileStream ($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $back = New-Object byte[] $ro.Length
    [void]$ro.Read($back, 0, $back.Length)
    if ($back.Length -ne $bytes.Length -or [Convert]::ToBase64String($back) -ne [Convert]::ToBase64String($bytes)) { Fail 'failed' 'The temporary copy changed before it was imported, so nothing was restored.' }
    # reg.exe writes even its success message to the error stream, so under "stop on error" merging that stream would turn a successful
    # import into a failure: capture it with errors set to "continue" for this one call, and judge by the exit code.
    $before = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $said = & reg.exe import $file 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $before }
  } finally {
    if ($ro) { $ro.Dispose() }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { Fail 'failed' ('Windows could not import it. ' + (((@($said) | ForEach-Object { [string]$_ }) -join ' ') -replace '\s+', ' ' -replace '^\s*ERROR:\s*', '').Trim()) }
  $out.status = 'restored'
  Finish
} catch {
  Fail 'failed' $_.Exception.Message
}
`;

const norm = (s) => String(s).toLowerCase();

// Compare what the file said with what the key holds now: every value NAME must be there, and strings and numbers must match.
function compareRestored(values, now) {
  const missing = [];
  const wrong = [];
  for (const v of values) {
    const key = now.find((k) => norm(k.key) === norm(v.key));
    const have = key?.exists ? (key.values ?? []).find((x) => norm(x.name) === norm(v.name)) : null;
    const label = `${v.key.split('\\').slice(-1)[0]}: ${v.name === '' ? '(default)' : v.name}`;
    if (!have) missing.push(label);
    else if (v.type === 'sz' && (have.kind !== 'String' || have.data !== v.data)) wrong.push(label);
    else if (v.type === 'dword' && (have.kind !== 'DWord' || Number(have.data) !== v.data)) wrong.push(label);
  }
  const keysMissing = [...new Set(values.map((v) => v.key))].filter((k) => !now.find((n) => norm(n.key) === norm(k) && n.exists));
  return { missing, wrong, keysMissing };
}

async function restoreKey(id, index, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const dir = await resolveBackup(id, d.backupRoot);
  const manifest = await readManifest(dir);
  const item = manifest?.results?.[index];
  if (!manifest || !Number.isInteger(index) || !item || item.ok !== true || item.kind !== 'registry' || typeof item.path !== 'string') throw new Error('That item is not in this backup.');
  const read = await readRegBackup(dir, item);
  if (read.error) throw new Error(read.error);

  if (/^HKEY_LOCAL_MACHINE\\/i.test(item.path)) {
    // all-users: one elevated step that gets the validated text inside the request
    const job = { mode: 'restore', key: item.path, reg: zlib.gzipSync(Buffer.from(read.text, 'utf8')).toString('base64'), resultFile: path.join(d.tmpDir, `webase-restore-${crypto.randomUUID()}.json`) };
    let r;
    try {
      r = await d.run(RESTORE_SCRIPT, job, { deadlineMs: PROMPT_MS, timeoutMs: 5 * 60 * 1000, tooBig: 'This backup is too big to restore with one prompt. Double-click the .reg file in File Explorer instead.' });
    } catch (e) {
      if (e.code === 'DECLINED') return { status: 'declined', message: 'The Windows permission prompt was declined, so nothing changed.' };
      if (e.code === 'TIMEOUT' || e.code === 'STILL_RUNNING') return { status: 'not-answered', message: e.message };
      throw e;
    }
    if (r.status !== 'restored') return { status: r.status, message: r.message || 'The key was not restored.' };
  } else {
    // current user: a fresh file of our own, imported unchanged
    const tmp = path.join(d.tmpDir, `webase-restore-${crypto.randomUUID()}.reg`);
    await fs.writeFile(tmp, encodeReg(read.text), { flag: 'wx' });
    try {
      await d.importKey(tmp);
    } catch {
      return { status: 'failed', message: 'Windows could not import it.' };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  // checked from here, by what the key holds now, not by "the key exists" (it may have existed before)
  const now = await d.readBack([...new Set(read.parsed.values.map((v) => v.key).concat(read.parsed.keys))]);
  const c = compareRestored(read.parsed.values, now);
  if (c.keysMissing.length || c.missing.length || c.wrong.length) {
    const bits = [...c.keysMissing.map((k) => `key ${k.split('\\').slice(-1)[0]} is missing`), ...c.missing.slice(0, 3).map((m) => `value ${m} is missing`), ...c.wrong.slice(0, 3).map((m) => `value ${m} is different`)];
    return { status: 'partial', message: `Windows reported success, but ${bits.join('; ')}.` };
  }
  return { status: 'restored', message: `Restored ${read.parsed.keys.length} key${read.parsed.keys.length === 1 ? '' : 's'} and ${read.parsed.values.length} value${read.parsed.values.length === 1 ? '' : 's'}.` };
}

// ---- putting a folder back from the Recycle Bin ------------------------------------------------------------------------------

async function restoreFolder(id, index, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const dir = await resolveBackup(id, d.backupRoot);
  const manifest = await readManifest(dir);
  const item = manifest?.results?.[index];
  if (!manifest || !Number.isInteger(index) || !item || item.ok !== true || !isBinItem(item) || typeof item.path !== 'string') throw new Error('That item is not in this backup.');
  const thing = item.kind; // 'folder' or 'file': both went to the Recycle Bin
  const how = item.kind === 'file' ? 'recycle-bin' : item.method ?? (inAllUsersPlace(item.path) ? 'admin-empty-folder' : 'recycle-bin');
  if (how !== 'recycle-bin') throw new Error('That folder was empty, so there is nothing to put back.');
  const why = whyFileRefused(item.path, d.roots);
  if (why || inAllUsersPlace(item.path)) throw new Error(why || 'This is not a place the app restores into.');
  if (await fs.lstat(item.path).then(() => true, () => false)) throw new Error(`A ${thing} with this name exists again, so it was not put back.`);

  const bin = await d.readBin(binNames(item));
  const hit = pickBinEntry(bin, item.path, manifest.when ? Date.parse(manifest.when) : null, item.kind);
  if (!hit.entry) throw new Error(hit.ambiguous ? 'Several entries with this name are in the Recycle Bin. Restore the right one there.' : 'It is no longer in the Recycle Bin.');
  const result = await d.undelete(hit.entry.binPath);
  if (result !== 'DONE') throw new Error('The Recycle Bin entry could not be found.');
  const back = await fs.lstat(item.path).then((s) => !s.isSymbolicLink() && (thing === 'file' ? s.isFile() : s.isDirectory()), () => false);
  if (!back) return { status: 'failed', message: `Windows did not put the ${thing} back.` };
  return { status: 'restored', message: `The ${thing} is back where it was.` };
}

// ---- deleting a backup -------------------------------------------------------------------------------------------------------

async function deleteBackup(id, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const dir = await resolveBackup(id, d.backupRoot);
  for (const name of await fs.readdir(dir)) {
    const st = await fs.lstat(path.join(dir, name));
    if (st.isSymbolicLink() || st.isDirectory()) throw new Error('This backup holds something unexpected, so it was not deleted.');
  }
  await fs.rm(dir, { recursive: true, force: true });
  return { deleted: !(await fs.lstat(dir).then(() => true, () => false)) };
}

async function backupDir(id, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  return resolveBackup(id, d.backupRoot);
}

module.exports = { listBackups, restoreKey, restoreFolder, deleteBackup, backupDir, pickBinEntry, compareRestored, RESTORE_SCRIPT, BACKUP_ID, BIN_LIST_SCRIPT, READ_SCRIPT, defaults };
