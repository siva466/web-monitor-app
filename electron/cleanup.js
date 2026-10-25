const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// Same age Windows' own Disk Cleanup uses for "Temporary files" (registry value LastAccess = 7 on this PC).
// shortcut: fixed, not a setting. Anything changed more recently (in any file inside a folder) is never listed or deleted.
const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A target is only cleaned if it clearly is a temp folder, whatever the environment says. If TEMP were ever set to
// a personal folder, Documents or Pictures would otherwise look like "old temporary files".
const TEMP_FOLDER_NAMES = new Set(['temp', 'tmp', 'crashdumps']);

function whyRefused(p) {
  if (!path.isAbsolute(p)) return 'not an absolute path';
  const full = path.resolve(p);
  if (full.toLowerCase() === path.parse(full).root.toLowerCase()) return 'a drive root';
  if (!TEMP_FOLDER_NAMES.has(path.basename(full).toLowerCase())) return 'not a folder named Temp, Tmp or CrashDumps';
  const lower = full.toLowerCase();
  const protectedFolders = [process.env.USERPROFILE, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean)
    .map((f) => path.resolve(f).toLowerCase());
  if (protectedFolders.some((f) => lower === f || f.startsWith(lower + path.sep))) return 'a system or profile folder';
  return null;
}

// Folders Windows creates itself (e.g. the low-integrity "Low" folder that sandboxed apps write to). Their contents are
// not touched by this tool.
const OWNED_BY_WINDOWS = new Set(['low']);

const defaultTargets = () => [
  { id: 'user-temp', label: 'Your temporary files', path: os.tmpdir(), needsAdmin: false },
  { id: 'crash-dumps', label: 'Crash dumps', path: path.join(process.env.LOCALAPPDATA || '', 'CrashDumps'), needsAdmin: false },
  { id: 'windows-temp', label: 'Windows temporary files', path: path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp'), needsAdmin: true },
];

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await fn(items[next++]); }));
}

// Size and newest change time of everything inside a folder. Links are never followed, only noted.
async function walk(dir) {
  const out = { size: 0, newest: 0, links: false, unreadable: 0 };
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    out.unreadable++;
    return out;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      out.unreadable++;
      continue;
    }
    if (st.isSymbolicLink()) {
      out.links = true;
      continue;
    }
    out.newest = Math.max(out.newest, st.mtimeMs);
    if (st.isDirectory()) {
      const sub = await walk(full);
      out.size += sub.size;
      out.newest = Math.max(out.newest, sub.newest);
      out.links ||= sub.links;
      out.unreadable += sub.unreadable;
    } else {
      out.size += st.size;
    }
  }
  return out;
}

// Lists the top-level items of a target that are safe to remove: old, and without links inside.
async function scanTarget(target, now = Date.now()) {
  const res = { ...target, items: [], totalBytes: 0, keptRecent: 0, keptLinks: 0, unreadable: 0, refused: whyRefused(target.path) };
  if (res.refused) return res;
  let names;
  try {
    names = await fs.readdir(target.path);
  } catch (e) {
    if (e.code !== 'ENOENT') res.unreadable++; // a folder that doesn't exist just has nothing in it
    return res;
  }
  const cutoff = now - MIN_AGE_MS;
  await pool(names, 8, async (name) => {
    if (OWNED_BY_WINDOWS.has(name.toLowerCase())) return;
    let st;
    try {
      st = await fs.lstat(path.join(target.path, name));
    } catch {
      res.unreadable++;
      return;
    }
    if (st.isSymbolicLink()) return void res.keptLinks++;
    let size = st.size;
    let newest = st.mtimeMs;
    if (st.isDirectory()) {
      const w = await walk(path.join(target.path, name));
      size = w.size;
      newest = Math.max(newest, w.newest);
      res.unreadable += w.unreadable;
      if (w.links) return void res.keptLinks++;
    }
    if (newest > cutoff) return void res.keptRecent++;
    res.items.push({ name, isDir: st.isDirectory(), sizeBytes: size, modifiedMs: newest });
    res.totalBytes += size;
  });
  res.items.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return res;
}

const reasonOf = (e) => (['EBUSY', 'ETXTBSY'].includes(e.code) ? 'in use' : ['EPERM', 'EACCES'].includes(e.code) ? 'access denied' : e.code || 'error');

// Deletes what it can, keeps going past files that are in use, and counts what was actually freed.
async function removeTree(p, st, stats) {
  if (st.isDirectory()) {
    let names = [];
    try {
      names = await fs.readdir(p);
    } catch (e) {
      stats.reasons.add(reasonOf(e));
      stats.failed++;
      return;
    }
    for (const name of names) {
      const child = path.join(p, name);
      let cst;
      try {
        cst = await fs.lstat(child);
      } catch {
        continue; // already gone
      }
      if (cst.isSymbolicLink()) {
        stats.reasons.add('link left alone');
        stats.failed++;
        continue;
      }
      await removeTree(child, cst, stats);
    }
    try {
      await fs.rmdir(p);
    } catch {
      // not empty (something inside was in use); already counted
    }
    return;
  }
  try {
    await fs.unlink(p);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    if (e.code === 'EPERM') {
      // read-only files need the flag cleared first
      try {
        await fs.chmod(p, 0o666);
        await fs.unlink(p);
        stats.freed += st.size;
        return;
      } catch (e2) {
        e = e2;
      }
    }
    stats.reasons.add(reasonOf(e));
    stats.failed++;
    return;
  }
  stats.freed += st.size;
}

async function deleteTarget(scan, now = Date.now()) {
  const refused = whyRefused(scan.path);
  if (refused) throw new Error(`Not cleaned: ${scan.label} does not look like a temp folder (${refused}).`);
  const root = path.resolve(scan.path);
  const cutoff = now - MIN_AGE_MS;
  const result = { id: scan.id, label: scan.label, freedBytes: 0, removedItems: 0, failedItems: 0, changedSince: 0, reasons: [] };
  const reasons = new Set();
  for (const item of scan.items) {
    const full = path.resolve(root, item.name);
    if (path.dirname(full) !== root) continue; // never leave the target folder, whatever the name looks like
    let st;
    try {
      st = await fs.lstat(full);
    } catch {
      continue; // already gone
    }
    // The folder may have changed since the scan: check again right before deleting.
    let recent = st.isSymbolicLink() || st.mtimeMs > cutoff;
    if (!recent && st.isDirectory()) {
      const w = await walk(full);
      recent = w.links || w.newest > cutoff;
    }
    if (recent) {
      result.changedSince++;
      continue;
    }
    const stats = { freed: 0, failed: 0, reasons: new Set() };
    await removeTree(full, st, stats);
    result.freedBytes += stats.freed;
    stats.reasons.forEach((r) => reasons.add(r));
    const stillThere = await fs.lstat(full).then(() => true, () => false);
    if (stillThere) result.failedItems++;
    else result.removedItems++;
  }
  result.reasons = [...reasons];
  return result;
}

let adminCache;
async function isAdmin() {
  adminCache ??= execFile('whoami.exe', ['/groups'], { windowsHide: true }).then(
    ({ stdout }) => stdout.includes('S-1-16-12288'), // "High Mandatory Level" = running as administrator
    () => false,
  );
  return adminCache;
}

let last = new Map();

async function scanCleanup(targets = defaultTargets()) {
  const admin = await isAdmin();
  const scans = [];
  for (const t of targets) scans.push(await scanTarget(t));
  last = new Map(scans.map((s) => [s.id, s]));
  return scans.map(({ items, refused, ...s }) => ({
    ...s,
    lockedReason: refused ? 'unsafe' : s.needsAdmin && !admin ? 'admin' : null,
    itemCount: items.length,
    topItems: items.slice(0, 50),
  }));
}

async function deleteCleanup(ids) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((i) => typeof i !== 'string')) throw new Error('Invalid request.');
  const admin = await isAdmin();
  const results = [];
  for (const id of ids) {
    const scan = last.get(id);
    if (!scan) throw new Error('The scan is out of date. Scan again and retry.');
    if (scan.refused) throw new Error(`Not cleaned: ${scan.label} does not look like a temp folder (${scan.refused}).`);
    if (scan.needsAdmin && !admin) throw new Error(`${scan.label} needs administrator rights to clean.`);
    results.push(await deleteTarget(scan));
  }
  return results;
}

module.exports = { scanCleanup, deleteCleanup, scanTarget, deleteTarget, defaultTargets, whyRefused, walk, isAdmin, removeTree, MIN_AGE_MS };
