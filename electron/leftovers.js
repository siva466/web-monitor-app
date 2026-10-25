const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { walk } = require('./cleanup');

// Looks for what an uninstalled app may have left behind. It only looks: nothing here deletes anything.
// Matching is by exact folder and key names taken from the app's own name and publisher, so it can miss leftovers that
// use other names (shortcut), and it never reports a name shorter than 4 characters or a generic one such as "Microsoft".

const GENERIC = new Set([
  'microsoft', 'windows', 'common files', 'programs', 'temp', 'system', 'system32', 'update', 'updates', 'setup', 'installer', 'program',
  'software', 'data', 'apps', 'app', 'office', 'cache', 'logs', 'local', 'roaming', 'packages', 'desktop', 'documents', 'classes', 'policies',
]);

const usable = (n) => !!n && n.length >= 4 && !GENERIC.has(n.toLowerCase());

// Windows may delete something for good instead of recycling it when it is too big for the Recycle Bin, so bigger items
// are never removed from here.
const BIN_LIMIT = 2 * 1024 ** 3;

// "PuTTY release 0.85 (64-bit)" -> "PuTTY"; "7-Zip 26.04 (x64 edition)" -> "7-Zip"
function cleanName(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/(?:\b(?:version|release|build)\b\s*)?\bv?\d+(?:\.\d+)+\b/gi, ' ') // "0.85", "v3.36.1", "release 0.85"
    .replace(/\b(x64|x86|64-bit|32-bit|release|version)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Simon Tatham" -> "Simon Tatham"; "Brave Software Inc." -> "Brave Software"
const cleanPublisher = (p) => String(p ?? '').replace(/[,.]?\s*\b(inc|ltd|llc|corp|corporation|gmbh|co|limited|s\.?a\.?)\b\.?$/i, '').replace(/[,.]+$/, '').trim();

const words = (s) => cleanName(s).toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(Boolean);

// A program that is still installed has no leftovers: what a scan would list is its own data. Returns that app, or null.
function stillInstalled(typedName, installed) {
  const typed = words(typedName);
  if (!typed.length) return null;
  return installed.find((a) => {
    const have = words(a.name);
    return have.length > 0 && (typed.every((w) => have.includes(w)) || have.every((w) => typed.includes(w)));
  }) ?? null;
}

function candidates(snapshot) {
  const names = new Set();
  const n = cleanName(snapshot.name);
  names.add(n);
  names.add(n.replace(/\s+/g, ''));
  if (snapshot.location) names.add(path.basename(String(snapshot.location).replace(/^"|"$/g, '').replace(/[\\/]+$/, '')));
  const p = cleanPublisher(snapshot.publisher);
  return {
    names: [...names].filter(usable),
    publishers: [...new Set([p, p.replace(/\s+/g, '')])].filter(usable), // PuTTY's own key is "SimonTatham": no space
  };
}

function defaultRoots(env = process.env) {
  const local = env.LOCALAPPDATA || '';
  return {
    files: [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.APPDATA, local, local && path.join(local, 'Programs'),
      env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      env.ProgramData && path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')].filter(Boolean),
    registry: ['HKEY_CURRENT_USER\\Software', 'HKEY_LOCAL_MACHINE\\SOFTWARE', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node'],
  };
}

const RANK = { high: 0, medium: 1, low: 2 };

// Which registry keys exist, with how many subkeys and values. Keys reach PowerShell as data, not pasted into the script.
const REGISTRY_SCRIPT = String.raw`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$keys = $env:WB_KEYS | ConvertFrom-Json
$found = foreach ($k in $keys) {
  $item = Get-Item -LiteralPath ('Registry::' + $k) -ErrorAction SilentlyContinue
  if ($item) { [pscustomobject]@{ key = $k; subkeys = $item.SubKeyCount; values = $item.ValueCount } }
}
ConvertTo-Json -InputObject @($found) -Compress
`;

async function registryExists(keys) {
  if (!keys.length) return [];
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REGISTRY_SCRIPT], {
    env: { ...process.env, WB_KEYS: JSON.stringify(keys) }, timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  return [].concat(JSON.parse(stdout.replace(/^﻿/, '') || '[]') ?? []).filter(Boolean);
}

// `otherPublisherApps`: how many other installed apps share the publisher, so a publisher folder is not mistaken for this app's.
async function scanLeftovers(snapshot, { roots = defaultRoots(), checkRegistry = registryExists, installed = [] } = {}) {
  const { names, publishers } = candidates(snapshot);
  const found = new Map();
  // Never list a folder that is, or holds, the install folder of a program that is still installed.
  const live = installed.map((a) => a.location).filter(Boolean).map((l) => path.resolve(String(l).replace(/^"|"$/g, '')).toLowerCase());
  let keptInstalled = 0;
  const add = (item) => {
    const p = path.resolve(item.path).toLowerCase();
    if (item.kind !== 'registry' && live.some((l) => l === p || l.startsWith(p + path.sep))) return void keptInstalled++;
    found.has(item.path.toLowerCase()) || found.set(item.path.toLowerCase(), item);
  };

  const folders = [];
  const recorded = snapshot.location && String(snapshot.location).replace(/^"|"$/g, '');
  if (recorded) folders.push({ p: recorded, confidence: 'high', reason: 'The install folder the app recorded' });
  for (const root of roots.files) {
    for (const n of names) folders.push({ p: path.join(root, n), confidence: 'medium', reason: 'Folder named like the app' });
    for (const pub of publishers) {
      for (const n of names) folders.push({ p: path.join(root, pub, n), confidence: 'medium', reason: 'Publisher and app folder' });
      folders.push({ p: path.join(root, pub), confidence: 'low', reason: 'Publisher folder: other apps by the same publisher may use it' });
    }
  }
  for (const f of folders) {
    let st;
    try {
      st = await fs.lstat(f.p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never follow links
    const w = st.isDirectory() ? await walk(f.p) : { size: st.size, links: false };
    const empty = st.isDirectory() && (await fs.readdir(f.p).catch(() => ['?'])).length === 0;
    add({ kind: st.isDirectory() ? 'folder' : 'file', path: f.p, confidence: f.confidence, reason: f.reason, sizeBytes: w.size, entries: null, hasLinks: w.links, empty, tooBig: w.size > BIN_LIMIT });
  }

  // A program removed in an earlier session has no uninstall entry to look for, only its name and publisher.
  const regs = snapshot.key ? [{ k: snapshot.key, confidence: 'high', reason: 'The uninstall entry is still listed' }] : [];
  for (const root of roots.registry) {
    for (const n of names) regs.push({ k: `${root}\\${n}`, confidence: 'medium', reason: 'Key named like the app' });
    for (const pub of publishers) {
      for (const n of names) regs.push({ k: `${root}\\${pub}\\${n}`, confidence: 'medium', reason: 'Publisher and app key' });
      regs.push({ k: `${root}\\${pub}`, confidence: 'low', reason: 'Publisher key: other apps by the same publisher may use it' });
    }
  }
  const existing = new Map((await checkRegistry(regs.map((r) => r.k))).map((e) => [e.key.toLowerCase(), e]));
  for (const r of regs) {
    const e = existing.get(r.k.toLowerCase());
    if (e) add({ kind: 'registry', path: r.k, confidence: r.confidence, reason: r.reason, sizeBytes: null, entries: `${e.subkeys} subkey${e.subkeys === 1 ? '' : 's'}, ${e.values} value${e.values === 1 ? '' : 's'}`, hasLinks: false, empty: e.subkeys === 0 && e.values === 0, tooBig: false });
  }

  const items = [...found.values()]
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || a.path.localeCompare(b.path))
    .map((item, i) => ({ ...item, id: String(i) })); // removal names items by these ids, from this scan only
  return { name: snapshot.name, publisher: snapshot.publisher, ownKey: snapshot.key ?? null, items, keptInstalled, searchedFor: { names, publishers }, placesChecked: folders.length + regs.length };
}

// What the window may type when it looks for a program removed earlier.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+#-]{2,59}$/u;
function manualSnapshot(name, publisher) {
  const n = String(name ?? '').trim();
  const p = String(publisher ?? '').trim();
  if (!NAME.test(n)) throw new Error('Type the program name, at least 3 characters (letters, digits, spaces and . _ + # - only).');
  if (p && !NAME.test(p)) throw new Error('The publisher can only contain letters, digits, spaces and . _ + # -');
  return { key: null, name: n, publisher: p || null, location: null };
}

module.exports = { scanLeftovers, manualSnapshot, stillInstalled, candidates, cleanName, cleanPublisher, defaultRoots, registryExists, usable, GENERIC, BIN_LIMIT };
