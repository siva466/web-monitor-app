const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { walk } = require('./cleanup');
const { defaultRoots, registryExists, usable, BIN_LIMIT } = require('./leftovers');
const { runElevated } = require('./leftover-admin');

// Removes leftovers that a scan found, and only those: the window names them by id from the latest scan, never by path.
// Every registry key is exported to a .reg file BEFORE it is deleted (no backup, no delete). Files and folders go to the
// Recycle Bin, not away for good. Publisher-level ("low") items are removed only when they are empty.
// All-users places (Program Files, ProgramData, HKLM) are handled only for EMPTY folders and registry keys, in one
// administrator step for the whole group (leftover-admin.js), so Windows asks once. Anything else there is left to the user.

const backupRoot = () => path.join(process.env.LOCALAPPDATA || '', 'WebaseSystemMonitor', 'backups');

const REG_ROOT = /^(HKEY_CURRENT_USER\\Software|HKEY_LOCAL_MACHINE\\SOFTWARE(?:\\WOW6432Node)?)\\/i;
const UNINSTALL_ENTRY = /^HKEY_(?:LOCAL_MACHINE|CURRENT_USER)\\SOFTWARE\\(?:WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^\\]+$/i;

const LOW = 'It may belong to other apps, so it is not removed.';
const ALL_USERS_FILE = 'It is in an all-users place and is not an empty folder, so this app leaves it to you. Use "Show in folder" and remove it in File Explorer.';

function whyRegistryRefused(p, ownKey) {
  if (ownKey && p.toLowerCase() === ownKey.toLowerCase() && UNINSTALL_ENTRY.test(p)) return null; // the app's own uninstall entry, still listed
  const m = REG_ROOT.exec(p);
  if (!m) return 'It is not a Software key this tool handles.';
  if (!usable(p.slice(m[0].length).split('\\')[0])) return 'It is a Windows or shared location.';
  return null;
}

function whyFileRefused(p, roots) {
  const full = path.resolve(p);
  const lower = full.toLowerCase();
  const root = roots.files
    .map((r) => path.resolve(r))
    .filter((r) => lower.startsWith(r.toLowerCase() + path.sep))
    .sort((a, b) => b.length - a.length)[0]; // the most specific folder, so ...\Local\Programs\App is judged by "App"
  if (!root) return 'It is outside the folders this tool handles.';
  if (!usable(path.relative(root, full).split(path.sep)[0])) return 'It is a Windows or shared location.';
  return null;
}

// Whether the drive holding an item has a Recycle Bin that will really keep it: a fixed drive, "remove files immediately"
// (NukeOnDelete) off, and the bin's own size limit. Windows keeps these per drive under the user's BitBucket key.
const BIN_SCRIPT = String.raw`
$root = $env:WB_ROOT
$type = (Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $root.Substring(0, 2) + "'")).DriveType
$guid = [regex]::Match((& mountvol $root /L), '\{[0-9a-fA-F-]{36}\}').Value
$k = if ($guid) { Get-Item -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $guid) -ErrorAction SilentlyContinue }
ConvertTo-Json -InputObject ([pscustomobject]@{ driveType = [int]$type; nuke = $(if ($k) { [int]$k.GetValue('NukeOnDelete', 0) } else { 0 }); maxMb = $(if ($k) { [int64]$k.GetValue('MaxCapacity', 0) } else { 0 }) }) -Compress
`;

async function binInfo(root) {
  if (!/^[A-Za-z]:\\$/.test(root)) throw new Error('not a drive root');
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', BIN_SCRIPT], { env: { ...process.env, WB_ROOT: root }, timeout: 30000, windowsHide: true });
  const j = JSON.parse(stdout.replace(/^﻿/, ''));
  return { driveType: j.driveType, nuke: j.nuke === 1, maxBytes: j.maxMb > 0 ? j.maxMb * 1024 * 1024 : null };
}

// Why something of this size would NOT be kept by the Recycle Bin of its drive (null = it would be): the drive has no Recycle Bin, is set
// to delete immediately, or the item is too big for the bin to be sure to hold it. Windows deletes for good, without asking, in those cases.
function whyNotRecoverable(size, bin, binLimit = BIN_LIMIT) {
  if (bin.driveType !== 3) return 'This drive has no Recycle Bin, so the removal could not be undone. Remove it yourself in File Explorer.';
  if (bin.nuke) return 'This drive is set to delete files immediately instead of using the Recycle Bin. Change that in the Recycle Bin properties, or remove it yourself.';
  if (size > (bin.maxBytes ? Math.min(binLimit, bin.maxBytes / 2) : binLimit)) return 'It is too big to be sure the Recycle Bin can hold it. Remove it yourself in File Explorer.';
  return null;
}

// All-users places. Removing something there needs administrator rights. Found live: asking Electron to move such a folder
// to the Recycle Bin never finishes (neither success nor error), so those never take that route.
function inAllUsersPlace(p) {
  const lower = path.resolve(p).toLowerCase();
  const e = process.env;
  // Folders an elevated installer creates under ProgramData are usually owned by Administrators too, so all of it counts.
  const places = [e.ProgramFiles, e['ProgramFiles(x86)'], e.SystemRoot, e.ProgramData].filter(Boolean);
  return places.some((r) => lower.startsWith(path.resolve(r).toLowerCase() + path.sep));
}

const isHklm = (p) => /^HKEY_LOCAL_MACHINE\\/i.test(p);

// Whether this app may remove a scanned item, from the scan's own facts, and whether that needs administrator rights.
// The window uses it to enable the tick box; removal asks again, so a stale or forged id cannot get past it.
function assessItem(item, { ownKey = null, roots, isAllUsers = inAllUsersPlace }) {
  const refuse = (allUsers, whyNot) => ({ allUsers, removable: false, whyNot });
  if (item.kind === 'registry') {
    const allUsers = isHklm(item.path);
    const why = whyRegistryRefused(item.path, ownKey);
    if (why) return refuse(allUsers, why);
    if (item.confidence === 'low' && !item.empty) return refuse(allUsers, LOW);
    return { allUsers, removable: true, whyNot: null };
  }
  const allUsers = isAllUsers(item.path);
  const why = whyFileRefused(item.path, roots);
  if (why) return refuse(allUsers, why);
  if (item.tooBig) return refuse(allUsers, 'It is over 2 GB, too big to be sure the Recycle Bin can hold it. Remove it yourself in File Explorer.');
  if (item.confidence === 'low' && !item.empty) return refuse(allUsers, LOW);
  if (allUsers && !(item.kind === 'folder' && item.empty)) return refuse(allUsers, ALL_USERS_FILE);
  return { allUsers, removable: true, whyNot: null };
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), ms))]);

const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = (s) => String(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';
const denied = (e) => /access is denied|EPERM|EACCES|permission/i.test([e?.code, e?.stderr, e?.message].filter(Boolean).join(' '));
const exists = (p) => fs.lstat(p).then(() => true, () => false);

const defaults = () => ({
  backupRoot: backupRoot(),
  roots: defaultRoots(),
  now: Date.now(),
  binLimit: BIN_LIMIT,
  binInfo,
  isAllUsers: inAllUsersPlace,
  runElevated,
  trashTimeoutMs: 45000,
  exportKey: (key, file) => execFile('reg.exe', ['export', key, file, '/y'], { windowsHide: true }),
  deleteKey: (key) => execFile('reg.exe', ['delete', key, '/f'], { windowsHide: true }),
  keyInfo: async (key) => (await registryExists([key]))[0] ?? null, // { subkeys, values } or null when the key is gone
  trashItem: async () => { throw new Error('No Recycle Bin available.'); },
});

async function removeLeftovers(scan, ids, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((i) => typeof i !== 'string')) throw new Error('Nothing is selected.');
  const byId = new Map(scan.items.map((i) => [i.id, i]));
  const chosen = ids.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error('The leftover list is out of date. Scan again.');
    return item;
  });

  const dir = path.join(d.backupRoot, `${stamp(d.now)}-${slug(scan.name)}`);
  let dirMade = false;
  const ensureDir = async () => {
    if (!dirMade) await fs.mkdir(dir, { recursive: true }); // only when something is really backed up or removed: no empty folders
    dirMade = true;
  };
  const results = [];
  // `how` says how a removed item can be put back: { method: 'reg-export', backupFile } | { method: 'recycle-bin' } | { method: 'admin-empty-folder' }
  const done = (item, ok, error, how = {}) => results.push({ path: item.path, kind: item.kind, ok, ...(error ? { error } : {}), ...(ok ? how : {}) });
  let n = 0;
  const bins = new Map(); // Recycle Bin facts per drive, asked once
  const regFile = (item) => path.join(dir, `${String(++n).padStart(2, '0')}-${slug(item.path.split('\\').slice(-2).join('-'))}.reg`);

  // Deepest first, so a key and the key above it can be chosen together.
  const deepestFirst = (a, b) => b.path.length - a.path.length;

  const mine = [];
  const allUsers = [];
  for (const item of chosen) {
    const a = assessItem(item, { ownKey: scan.ownKey, roots: d.roots, isAllUsers: d.isAllUsers });
    if (!a.removable) done(item, false, a.whyNot);
    else (a.allUsers ? allUsers : mine).push(item);
  }

  for (const item of mine.filter((i) => i.kind === 'registry').sort(deepestFirst)) {
    const info = await d.keyInfo(item.path);
    if (!info) { done(item, true); continue; } // already gone
    if (item.confidence === 'low' && (info.subkeys > 0 || info.values > 0)) { done(item, false, LOW); continue; }
    const file = regFile(item);
    try {
      await ensureDir();
      await d.exportKey(item.path, file);
      if ((await fs.stat(file)).size === 0) throw new Error('empty backup');
    } catch (e) {
      done(item, false, denied(e) ? 'Needs administrator rights.' : 'It could not be backed up, so it was not removed.');
      continue;
    }
    try {
      await d.deleteKey(item.path);
    } catch (e) {
      done(item, false, denied(e) ? 'Needs administrator rights.' : 'Windows could not remove it.');
      continue;
    }
    if (await d.keyInfo(item.path)) done(item, false, 'It is still there after removal.');
    else done(item, true, undefined, { method: 'reg-export', backupFile: path.basename(file) });
  }

  for (const item of mine.filter((i) => i.kind !== 'registry').sort(deepestFirst)) {
    let st;
    try {
      st = await fs.lstat(item.path);
    } catch {
      done(item, true); // already gone
      continue;
    }
    if (st.isSymbolicLink()) { done(item, false, 'It is a link, which is never followed.'); continue; }
    let size = st.size;
    if (st.isDirectory()) {
      if (item.confidence === 'low' && (await fs.readdir(item.path)).length > 0) { done(item, false, LOW); continue; }
      const w = await walk(item.path);
      if (w.links) { done(item, false, 'It contains links, which are never followed.'); continue; }
      size = w.size;
    } else if (item.confidence === 'low') {
      done(item, false, LOW);
      continue;
    }
    // "Moved to the Recycle Bin" must really mean recoverable. Windows deletes for good, without asking, when the drive has no
    // Recycle Bin, is set to remove files immediately, or the item does not fit.
    const root = path.parse(path.resolve(item.path)).root;
    let bin;
    try {
      bin = bins.get(root) ?? (await d.binInfo(root));
      bins.set(root, bin);
    } catch {
      done(item, false, 'The Recycle Bin setting could not be checked, so it was not removed.');
      continue;
    }
    const notKept = whyNotRecoverable(size, bin, d.binLimit);
    if (notKept) { done(item, false, notKept); continue; }
    try {
      await withTimeout(d.trashItem(path.resolve(item.path)), d.trashTimeoutMs);
    } catch (e) {
      done(item, false, e.code === 'ETIMEDOUT' ? 'Windows did not finish moving it to the Recycle Bin. It may need administrator rights; remove it in File Explorer.' : denied(e) ? 'Needs administrator rights.' : 'Windows could not move it to the Recycle Bin.');
      continue;
    }
    if (await exists(item.path)) done(item, false, 'It is still there after removal.');
    else done(item, true, undefined, { method: 'recycle-bin' });
  }

  // All-users items (HKLM keys, empty folders in Program Files / ProgramData): checked here first so Windows is not asked about
  // something that is already gone or not eligible, then removed in ONE administrator step. Afterwards every item is checked
  // again from here, not taken on the helper's word.
  const batch = [];
  for (const item of allUsers.sort(deepestFirst)) {
    if (item.kind === 'registry') {
      const info = await d.keyInfo(item.path);
      if (!info) { done(item, true); continue; }
      if (item.confidence === 'low' && (info.subkeys > 0 || info.values > 0)) { done(item, false, LOW); continue; }
      batch.push({ item, job: { id: item.id, kind: 'registry', path: item.path, requireEmpty: item.confidence === 'low' } });
    } else {
      let st;
      try {
        st = await fs.lstat(item.path);
      } catch {
        done(item, true);
        continue;
      }
      if (st.isSymbolicLink()) { done(item, false, 'It is a link, which is never followed.'); continue; }
      if (!st.isDirectory()) { done(item, false, ALL_USERS_FILE); continue; }
      if ((await fs.readdir(item.path)).length > 0) { done(item, false, 'It is not empty, so this app leaves it to you. Use "Show in folder" and remove it in File Explorer.'); continue; }
      batch.push({ item, job: { id: item.id, kind: 'folder', path: path.resolve(item.path) } });
    }
  }
  if (batch.length) {
    await ensureDir();
    for (const b of batch) if (b.job.kind === 'registry') b.job.backup = regFile(b.item);
    const job = {
      items: batch.map((b) => b.job),
      roots: d.roots.files.filter((r) => d.isAllUsers(path.join(r, 'x'))).map((r) => path.resolve(r)),
      ownKey: scan.ownKey || null,
      resultFile: path.join(dir, '.admin-result.json'),
    };
    let reported = [];
    let runError = null;
    try {
      reported = await d.runElevated(job);
    } catch (e) {
      // per item: other items of the same removal (user-level ones) may already have been removed, so not "nothing changed"
      runError = e.code === 'DECLINED' ? 'The Windows permission prompt was declined, so this was left as it is.' : e.code === 'TIMEOUT' ? e.message : `The administrator step failed. ${e.message}`;
    }
    const said = new Map(reported.map((r) => [String(r.id), r]));
    for (const { item, job: j } of batch) {
      const gone = j.kind === 'registry' ? !(await d.keyInfo(item.path)) : !(await exists(item.path));
      const own = said.get(item.id);
      if (!gone) { done(item, false, runError ?? (own && !own.ok && own.error ? own.error : 'It is still there after removal.')); continue; }
      const saved = j.backup ? await fs.stat(j.backup).then((s) => s.size > 0, () => false) : true;
      if (saved) done(item, true, undefined, j.backup ? { method: 'reg-export', backupFile: path.basename(j.backup) } : { method: 'admin-empty-folder' });
      else done(item, false, 'It is gone, but its backup file is missing, so it cannot be put back from here.');
    }
  }

  const summary = { backupDir: null, removed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  if (!dirMade) return summary; // nothing was backed up or removed: leave no trace
  const backedUp = (await fs.readdir(dir)).some((f) => f.endsWith('.reg'));
  if (!summary.removed && !backedUp) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rmdir(d.backupRoot).catch(() => {}); // only if that left it empty, and then the app's own folder above it too
    await fs.rmdir(path.dirname(d.backupRoot)).catch(() => {});
    return summary;
  }
  summary.backupDir = dir;
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ format: 2, when: new Date(d.now).toISOString(), app: scan.name, publisher: scan.publisher, results, note: 'Registry keys are backed up as .reg files here (double-click one to put it back). Files and folders went to the Recycle Bin; empty folders removed from all-users places held nothing, so they have no backup.' }, null, 2));
  return summary;
}

module.exports = { removeLeftovers, assessItem, whyRegistryRefused, whyFileRefused, inAllUsersPlace, backupRoot, binInfo, whyNotRecoverable };
