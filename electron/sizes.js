const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// How big things are. Read-only. Links and junctions are never followed (they are counted and skipped), so nothing is counted twice or
// leaves the folder; places that cannot be read are counted, not hidden. Sizes are FILE sizes, not space on disk (hard links, for example
// in WinSxS, can be counted more than once).

const MAX_ROWS = 200;
const DEFAULT_BUDGET_MS = 2 * 60 * 1000;

// At most `max` file-system calls at once, so a scan does not starve the rest of the PC.
function limiter(max) {
  let active = 0;
  const waiting = [];
  const acquire = () => (active < max ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next(); // the slot passes to the next waiter
    else active--;
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

// Total of everything inside a folder.
async function measure(dir, ctx) {
  const out = { bytes: 0, files: 0, dirs: 0, links: 0, denied: 0, partial: false };
  const stop = () => ctx.signal?.aborted || Date.now() > ctx.deadline;
  const visit = async (d) => {
    if (stop()) { out.partial = true; return; }
    let ents;
    try {
      ents = await ctx.run(() => ctx.fsApi.readdir(d, { withFileTypes: true }));
    } catch {
      out.denied++;
      return;
    }
    await Promise.all(ents.map(async (e) => {
      if (stop()) { out.partial = true; return; }
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { out.links++; return; }
      if (e.isDirectory()) { out.dirs++; return visit(p); }
      try {
        const st = await ctx.run(() => ctx.fsApi.lstat(p));
        if (st.isSymbolicLink()) out.links++;
        else { out.files++; out.bytes += st.size; }
      } catch {
        out.denied++;
      }
    }));
  };
  await visit(dir);
  return out;
}

// Sizes of the files in one folder as the directory itself reports them: works for files that cannot be opened (pagefile.sys,
// hiberfil.sys), which fail with EPERM on a normal stat. Returns { lowercase name: bytes }.
const DIR_SCRIPT = String.raw`
$out = Get-ChildItem -LiteralPath $env:WB_DIR -Force -File -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.Name; length = $_.Length } }
ConvertTo-Json -InputObject @($out) -Compress
`;
async function dirEntrySizes(dir) {
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DIR_SCRIPT], { env: { ...process.env, WB_DIR: dir }, timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return Object.fromEntries([].concat(JSON.parse(stdout.replace(/^﻿/, '').trim() || '[]')).map((f) => [String(f.name).toLowerCase(), Number(f.length)]));
}

// The children of a folder with their sizes, biggest first: { total, rows, rest, links, denied, partial }.
// rows: [{ name, kind: 'folder'|'file'|'link', bytes, files, denied, partial, note? }], at most `maxRows`, and `rest` sums the others.
async function listFolder(dir, { signal, budgetMs = DEFAULT_BUDGET_MS, concurrency = 24, fsApi = fsp, fallback = dirEntrySizes, maxRows = MAX_ROWS } = {}) {
  const ctx = { fsApi, run: limiter(concurrency), signal, deadline: Date.now() + budgetMs };
  let ents;
  try {
    ents = await fsApi.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error('This folder cannot be read.');
  }
  const children = [];
  const unopened = [];
  await Promise.all(ents.map(async (e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { children.push({ name: e.name, kind: 'link', bytes: 0, files: 0, denied: 0, partial: false }); return; }
    if (e.isDirectory()) {
      const m = await measure(p, ctx);
      children.push({ name: e.name, kind: 'folder', bytes: m.bytes, files: m.files, denied: m.denied, partial: m.partial, links: m.links });
      return;
    }
    try {
      const st = await ctx.run(() => fsApi.lstat(p));
      children.push(st.isSymbolicLink() ? { name: e.name, kind: 'link', bytes: 0, files: 0, denied: 0, partial: false } : { name: e.name, kind: 'file', bytes: st.size, files: 1, denied: 0, partial: false });
    } catch {
      unopened.push(e.name);
    }
  }));
  if (unopened.length) {
    const sizes = await fallback(dir).catch(() => ({}));
    for (const name of unopened) {
      const b = sizes[name.toLowerCase()];
      children.push({ name, kind: 'file', bytes: b ?? 0, files: 1, denied: b === undefined ? 1 : 0, partial: false, note: b === undefined ? 'This file cannot be read.' : 'Size taken from the directory; the file is in use or protected.' });
    }
  }
  children.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const shown = children.slice(0, maxRows);
  const others = children.slice(maxRows);
  return {
    total: children.reduce((n, c) => n + c.bytes, 0),
    rows: shown,
    rest: others.length ? { count: others.length, bytes: others.reduce((n, c) => n + c.bytes, 0) } : null,
    links: children.filter((c) => c.kind === 'link').length + children.reduce((n, c) => n + (c.links ?? 0), 0),
    denied: children.reduce((n, c) => n + c.denied, 0),
    partial: ctx.signal?.aborted === true || children.some((c) => c.partial),
  };
}

module.exports = { listFolder, measure, limiter, dirEntrySizes, DIR_SCRIPT, MAX_ROWS, DEFAULT_BUDGET_MS };
