const path = require('path');
const { listFolder } = require('./sizes');

// The Folders tab: where the space is. Read-only. A scan starts at a NAMED place (your user folder, Program Files, a drive), and going
// deeper names an id from the listing the window was given; this module turns those into paths. The window never sends a path.

const MAX_IDS = 4000; // ids are remembered for the latest scans only
let next = 1;
const ids = new Map(); // id -> { path, kind, label, parent }
let current = null; // the running scan's AbortController

function remember(entry) {
  const id = String(next++);
  ids.set(id, entry);
  if (ids.size > MAX_IDS) ids.delete(ids.keys().next().value);
  return id;
}

const letterOf = (disk) => /^([A-Za-z]):/.exec(disk.name ?? '')?.[1]?.toUpperCase() ?? null;

function defaults() {
  return {
    env: process.env,
    disks: async () => (await require('./system').getDisks()).map((d) => ({ letter: letterOf(d), used: d.used, size: d.size })).filter((d) => d.letter),
    list: listFolder,
  };
}

async function drives(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  return (await d.disks()).map((x) => ({ letter: x.letter, used: x.used, size: x.size, free: Math.max(0, x.size - x.used) }));
}

async function starts(d) {
  const e = d.env;
  const places = [
    { key: 'profile', label: 'Your user folder', path: e.USERPROFILE },
    { key: 'pf', label: 'Program Files', path: e.ProgramFiles },
    { key: 'pf86', label: 'Program Files (x86)', path: e['ProgramFiles(x86)'] },
    { key: 'pdata', label: 'ProgramData', path: e.ProgramData },
  ].filter((p) => p.path);
  for (const x of await d.disks()) places.push({ key: `drive:${x.letter}`, label: `Drive ${x.letter}:`, path: `${x.letter}:\\`, drive: x });
  return places;
}

async function startList(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  return (await starts(d)).map(({ key, label }) => ({ key, label }));
}

function trailOf(id) {
  const trail = [];
  for (let at = id; at; at = ids.get(at)?.parent) {
    const e = ids.get(at);
    if (!e) break;
    trail.unshift({ id: at, label: e.label });
  }
  return trail;
}

async function scan(rootId, entry, drive, d) {
  current?.abort(); // a new scan replaces a running one
  const ac = new AbortController();
  current = ac;
  const t = Date.now();
  let r;
  try {
    r = await d.list(entry.path, { signal: ac.signal });
  } finally {
    if (current === ac) current = null;
  }
  const rows = r.rows.map((c) => ({
    id: c.kind === 'link' ? null : remember({ path: path.join(entry.path, c.name), kind: c.kind, label: c.name, parent: rootId }),
    name: c.name,
    kind: c.kind,
    bytes: c.bytes,
    files: c.files,
    share: r.total > 0 ? c.bytes / r.total : 0,
    denied: c.denied,
    partial: c.partial,
    note: c.note ?? null,
  }));
  // for a whole drive: what Windows says is used minus what could be counted (System Volume Information, protected folders...)
  const notCounted = drive && !r.partial && drive.used > r.total ? drive.used - r.total : null;
  return { id: rootId, path: entry.path, trail: trailOf(rootId), total: r.total, rows, rest: r.rest, links: r.links, denied: r.denied, partial: r.partial, drive: drive ? { letter: drive.letter, used: drive.used, size: drive.size } : null, notCounted, tookMs: Date.now() - t };
}

async function scanStart(key, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const place = (await starts(d)).find((p) => p.key === key);
  if (!place) throw new Error('That is not a place this page can look at.');
  ids.clear(); // a new start forgets the old listings
  const id = remember({ path: path.resolve(place.path), kind: 'folder', label: place.label, parent: null });
  return scan(id, ids.get(id), place.drive ?? null, d);
}

async function scanChild(id, overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const entry = typeof id === 'string' ? ids.get(id) : null;
  if (!entry || entry.kind !== 'folder') throw new Error('That folder is not in the latest listing. Start again.');
  return scan(id, entry, null, d);
}

const cancel = () => { current?.abort(); };

// for "Show in File Explorer": the path of a listed row (a folder or a file), by id
function resolve(id) {
  const e = typeof id === 'string' ? ids.get(id) : null;
  if (!e) throw new Error('That item is not in the latest listing.');
  return e.path;
}

module.exports = { drives, startList, scanStart, scanChild, cancel, resolve, _reset: () => { ids.clear(); next = 1; current = null; } };
