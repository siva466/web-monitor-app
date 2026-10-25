const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { measure, limiter } = require('./sizes');

// The Recycle Bin: what is in it, how big, and emptying it. The list comes from the SHELL (what Explorer shows), never from the raw
// $Recycle.Bin folder, which can hold orphaned "$I" records with no data (found here: six of them while the shell listed nothing).
// Sizes are measured from each entry's real data path. Emptying is permanent, so it only goes ahead for exactly what was looked at.

const SHOW = 100; // rows sent to the window; the totals and the guard cover ALL entries

const LIST_SCRIPT = String.raw`
$bin = (New-Object -ComObject Shell.Application).NameSpace(10)
$out = foreach ($i in $bin.Items()) {
  $when = $i.ExtendedProperty('System.Recycle.DateDeleted')
  [pscustomobject]@{ name = $i.Name; from = [string]$i.ExtendedProperty('System.Recycle.DeletedFrom'); deleted = $(if ($when) { ([datetime]$when).ToUniversalTime().ToString('o') } else { $null }); isFolder = [bool]$i.IsFolder; binPath = [string]$i.Path }
}
ConvertTo-Json -InputObject @($out) -Compress
`;
// Errors do not decide the outcome (a drive with no bin can make this complain even when it worked): the bin is read again afterwards.
const CLEAR_SCRIPT = String.raw`
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
exit 0
`;

const ps = (script, timeout) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const drive = (p) => (/^([A-Za-z]):/.exec(p)?.[1] ?? '?').toUpperCase();

const defaults = () => ({
  readItems: async () => [].concat(JSON.parse((await ps(LIST_SCRIPT, 180000)).stdout.replace(/^﻿/, '').trim() || '[]')),
  sizeOf: async (binPath) => {
    const st = await fsp.lstat(binPath);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    return (await measure(binPath, { fsApi: fsp, run: limiter(16), deadline: Date.now() + 60000 })).bytes;
  },
  clear: async () => { await ps(CLEAR_SCRIPT, 300000).catch(() => {}); },
});

let seen = null; // the entry paths of the last listing the window was given: every entry, not just the ones shown

// Everything in the bin: { items (biggest first), totals: { items, bytes }, drives: [{ drive, items, bytes }] }
async function readBin(d) {
  const raw = await d.readItems();
  const run = limiter(8);
  const items = await Promise.all(raw.map((r) => run(async () => {
    let bytes = 0;
    try {
      bytes = await d.sizeOf(r.binPath);
    } catch {
      bytes = 0; // not readable: shown as 0, never guessed
    }
    return { name: r.name, from: r.from, deleted: r.deleted, isFolder: r.isFolder, binPath: r.binPath, drive: drive(r.binPath), bytes };
  })));
  items.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const by = new Map();
  for (const i of items) {
    const e = by.get(i.drive) ?? { drive: i.drive, items: 0, bytes: 0 };
    e.items++;
    e.bytes += i.bytes;
    by.set(i.drive, e);
  }
  return { items, totals: { items: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0) }, drives: [...by.values()].sort((a, b) => a.drive.localeCompare(b.drive)) };
}

async function listBin(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const bin = await readBin(d);
  seen = new Set(bin.items.map((i) => i.binPath.toLowerCase()));
  return {
    totals: bin.totals,
    drives: bin.drives,
    shown: bin.items.slice(0, SHOW).map(({ binPath, ...row }) => row), // the window never gets the internal paths
    hidden: Math.max(0, bin.items.length - SHOW),
    checkedAt: Date.now(),
  };
}

// Bytes each drive's bin holds right now (for "will this batch fit?")
async function binUsage(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const bin = await readBin(d);
  return Object.fromEntries(bin.drives.map((x) => [x.drive, x.bytes]));
}

async function emptyBin(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  if (!seen) throw new Error('Look at the Recycle Bin first, then empty it.');
  const before = await readBin(d);
  const arrived = before.items.filter((i) => !seen.has(i.binPath.toLowerCase()));
  if (arrived.length) throw new Error(`The Recycle Bin has changed since you looked: ${arrived.length} new item${arrived.length === 1 ? '' : 's'}. Refresh and check what is in it before emptying.`);
  if (!before.items.length) return { status: 'empty', freedBytes: 0, remaining: 0, message: 'The Recycle Bin was already empty.' };
  await Promise.resolve(d.clear()).catch(() => {}); // an error here does not decide the outcome
  const after = await readBin(d); // judged by what is left, not by what the command said
  seen = new Set(after.items.map((i) => i.binPath.toLowerCase()));
  const freed = Math.max(0, before.totals.bytes - after.totals.bytes);
  return after.items.length === 0
    ? { status: 'emptied', freedBytes: freed, remaining: 0, message: `Emptied ${before.totals.items} item${before.totals.items === 1 ? '' : 's'}.` }
    : { status: 'partial', freedBytes: freed, remaining: after.items.length, message: `${after.items.length} item${after.items.length === 1 ? '' : 's'} could not be removed (in use or protected).` };
}

module.exports = { listBin, emptyBin, binUsage, SHOW, LIST_SCRIPT, CLEAR_SCRIPT, _forget: () => { seen = null; } };
