const fsp = require('fs/promises');
const path = require('path');
const { limiter } = require('./sizes');
const { binInfo, whyNotRecoverable } = require('./leftover-delete');
const { binUsage } = require('./recyclebin');
const { BIN_LIMIT } = require('./leftovers');

// Large files in the Downloads folder: find them (read-only), and move chosen ones to the Recycle Bin after a preview and a confirm.
// A file is only moved if it is a plain file inside Downloads, was in the latest scan, has NOT changed since that scan (size and modified
// time), and the drive's Recycle Bin will really keep it AND has room for the whole batch (a full bin makes room by permanently
// deleting its oldest items, which may be yours).

const MAX_FILES = 300;
const TRASH_TIMEOUT_MS = 45000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), ms))]);
const driveOf = (p) => (/^([A-Za-z]):/.exec(p)?.[1] ?? '?').toUpperCase();
const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

// Every file at or above minBytes under root, biggest first. Links are never followed.
async function scanLarge(root, { minBytes, fsApi = fsp, concurrency = 24, now = Date.now(), max = MAX_FILES } = {}) {
  const run = limiter(concurrency);
  const found = [];
  const seen = { files: 0, bytes: 0, denied: 0 };
  const visit = async (dir) => {
    let ents;
    try {
      ents = await run(() => fsApi.readdir(dir, { withFileTypes: true }));
    } catch {
      seen.denied++;
      return;
    }
    await Promise.all(ents.map(async (e) => {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) return;
      if (e.isDirectory()) return visit(p);
      try {
        const st = await run(() => fsApi.lstat(p));
        if (st.isSymbolicLink() || !st.isFile()) return;
        seen.files++;
        seen.bytes += st.size;
        if (st.size >= minBytes) found.push({ path: p, name: e.name, folder: path.relative(root, dir), bytes: st.size, modifiedMs: st.mtimeMs, ageDays: Math.max(0, Math.floor((now - st.mtimeMs) / 86400000)) });
      } catch {
        seen.denied++;
      }
    }));
  };
  await visit(root);
  found.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { files: found.slice(0, max), matching: found.length, matchingBytes: found.reduce((n, f) => n + f.bytes, 0), scanned: seen };
}

// For the page: which listed files the Recycle Bin would NOT keep, with the reason (whyNot: null = it would). One bin lookup per drive.
// This only informs the window (the box is disabled); trashLarge checks again before anything moves.
async function annotate(files, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const bins = new Map();
  const out = [];
  for (const f of files) {
    const drv = driveOf(f.path);
    if (!bins.has(drv)) bins.set(drv, await d.binInfo(`${drv}:\\`).catch(() => null));
    const bin = bins.get(drv);
    out.push({ ...f, whyNot: bin ? whyNotRecoverable(f.bytes, bin, d.binLimit) : 'The Recycle Bin setting could not be checked, so this file cannot be moved from here.' });
  }
  return out;
}

const defaults = () => ({
  fsApi: fsp,
  binInfo,
  binUsage,
  binLimit: BIN_LIMIT,
  trashItem: async () => { throw new Error('No Recycle Bin available.'); },
  trashTimeoutMs: TRASH_TIMEOUT_MS,
});

// items: [{ path, bytes, modifiedMs }] as recorded by the latest scan (resolved from ids by the caller). Returns one result per item.
async function trashLarge(root, items, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const results = [];
  const resolvedRoot = path.resolve(root);
  const eligible = [];
  const refuse = (it, error) => results.push({ path: it.path, bytes: it.bytes, ok: false, error });

  for (const it of items) {
    const full = path.resolve(it.path);
    if (!full.toLowerCase().startsWith(resolvedRoot.toLowerCase() + path.sep)) { refuse(it, 'It is not inside the Downloads folder.'); continue; }
    // no link anywhere between Downloads and the file
    let linked = false;
    for (let dir = path.dirname(full); dir.length > resolvedRoot.length; dir = path.dirname(dir)) {
      if ((await d.fsApi.lstat(dir).catch(() => null))?.isSymbolicLink()) { linked = true; break; }
    }
    if (linked) { refuse(it, 'A folder above it is a link, which is never followed.'); continue; }
    let st;
    try {
      st = await d.fsApi.lstat(full);
    } catch {
      results.push({ path: it.path, bytes: it.bytes, ok: true, already: true }); // already gone
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) { refuse(it, 'It is not a plain file any more.'); continue; }
    if (st.size !== it.bytes || Math.abs(st.mtimeMs - it.modifiedMs) > 1) { refuse(it, 'It has changed since the scan, so it was left alone. Scan again.'); continue; }
    eligible.push({ ...it, full });
  }

  // the drive's Recycle Bin: will it keep each file, and is there room for the whole batch on that drive?
  const byDrive = new Map();
  for (const it of eligible) byDrive.set(driveOf(it.full), [...(byDrive.get(driveOf(it.full)) ?? []), it]);
  const ok = [];
  let used = null;
  for (const [drv, list] of byDrive) {
    let bin;
    try {
      bin = await d.binInfo(`${drv}:\\`);
    } catch {
      list.forEach((it) => refuse(it, 'The Recycle Bin setting could not be checked, so it was not removed.'));
      continue;
    }
    const each = list.map((it) => ({ it, why: whyNotRecoverable(it.bytes, bin, d.binLimit) }));
    each.filter((x) => x.why).forEach((x) => refuse(x.it, x.why));
    const fine = each.filter((x) => !x.why).map((x) => x.it);
    if (!fine.length) continue;
    const batch = fine.reduce((n, it) => n + it.bytes, 0);
    used ??= await d.binUsage().catch(() => null);
    if (used === null) { fine.forEach((it) => refuse(it, 'The Recycle Bin could not be read, so it cannot be checked for room. Nothing was removed.')); continue; }
    const capacity = bin.maxBytes ?? d.binLimit;
    const room = Math.max(0, capacity - (used[drv] ?? 0));
    if (batch > room) {
      fine.forEach((it) => refuse(it, `The Recycle Bin on ${drv}: has room for about ${mb(room)} more and these files add up to ${mb(batch)}. A full bin deletes its oldest items for good, so nothing was removed. Choose fewer files, or empty the Recycle Bin first.`));
      continue;
    }
    ok.push(...fine);
  }

  for (const it of ok) {
    try {
      await withTimeout(d.trashItem(it.full), d.trashTimeoutMs);
    } catch (e) {
      refuse(it, e.code === 'ETIMEDOUT' ? 'Windows did not finish moving it to the Recycle Bin.' : 'Windows could not move it to the Recycle Bin (it may be open in another program).');
      continue;
    }
    if (await d.fsApi.lstat(it.full).then(() => true, () => false)) refuse(it, 'It is still there after the move.');
    else results.push({ path: it.path, bytes: it.bytes, ok: true });
  }
  const freed = results.filter((r) => r.ok && !r.already).reduce((n, r) => n + r.bytes, 0);
  return { results, moved: results.filter((r) => r.ok && !r.already).length, failed: results.filter((r) => !r.ok).length, freedBytes: freed };
}

module.exports = { scanLarge, trashLarge, annotate, MAX_FILES };
