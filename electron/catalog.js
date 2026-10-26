const fs = require('fs/promises');
const path = require('path');
const { CATALOG } = require('./catalog-data');
const { PACKAGE_ID, installApp, listInstalled } = require('./winget');

// The app catalog: a fixed, curated list of free apps by winget package id. The window only ever names an id from this list; anything else is
// refused here. Installing goes through installApp (winget's community catalogue, silent, judged by whether winget then lists it as installed).
// Selections can be saved to and read from a JSON file chosen in a system file dialog: the window never sends or receives a path.

const MAX_FILE_BYTES = 512 * 1024;
const MAX_IDS = 2000;
const FORMAT = 'webase-apps';

const flat = () => CATALOG.flatMap((c) => c.apps);
const inCatalog = (id) => typeof id === 'string' && flat().some((a) => a.id === id);

// Every catalog app with whether winget knows it as installed (and its version and any newer version).
async function listCatalog(deps = {}) {
  const installed = new Map((await (deps.listInstalled ?? listInstalled)()).map((r) => [r.id.toLowerCase(), r]));
  return {
    categories: CATALOG.map((c) => ({
      name: c.name,
      apps: c.apps.map((a) => {
        const row = installed.get(a.id.toLowerCase());
        return { id: a.id, name: a.name, note: a.note, state: !row ? 'missing' : row.available ? 'update' : 'installed', version: row?.version ?? null, available: row?.available ?? null };
      }),
    })),
    checkedAt: Date.now(),
  };
}

// One app from the catalog. Throws for anything that is not in it; "already installed" comes back from installApp as an error.
function installFromCatalog(id, deps = {}) {
  if (!inCatalog(id)) throw new Error('That app is not in the catalog.');
  return (deps.installApp ?? installApp)(id);
}

// ids -> a file the person names in a save dialog. Returns { saved: false } when the dialog is cancelled.
async function exportSelection(ids, { showSave, fsApi = fs, now = () => new Date() }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((i) => typeof i === 'string')) throw new Error('Nothing is selected.');
  const unknown = ids.find((i) => !inCatalog(i));
  if (unknown !== undefined) throw new Error('That app is not in the catalog.');
  const chosen = new Set(ids);
  const apps = flat().map((a) => a.id).filter((id) => chosen.has(id)); // catalog order, no repeats
  const target = await showSave('webase-apps.json');
  if (!target) return { saved: false };
  await fsApi.writeFile(target, JSON.stringify({ format: FORMAT, version: 1, created: now().toISOString(), apps }, null, 2), 'utf8');
  return { saved: true, name: path.basename(target), count: apps.length };
}

// The package ids in a file: ours ({ apps: [...] }) or one made by `winget export` ({ Sources: [{ Packages: [{ PackageIdentifier }] }] }).
function idsFromFile(json) {
  if (json && Array.isArray(json.apps)) return json.apps;
  if (json && Array.isArray(json.Sources)) return json.Sources.flatMap((s) => (Array.isArray(s?.Packages) ? s.Packages.map((p) => p?.PackageIdentifier) : []));
  throw new Error('This file is not a list of apps. Use a file saved from here, or made with "winget export".');
}

// A file the person picks in an open dialog. Only ids that are in the catalog come back as `known`; the rest are only counted.
async function importSelection({ showOpen, fsApi = fs }) {
  const file = await showOpen();
  if (!file) return { canceled: true };
  const st = await fsApi.stat(file);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('That file is not a small JSON list of apps.');
  let json;
  try {
    json = JSON.parse((await fsApi.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  // winget ids are not case-sensitive, so "mozilla.firefox" in a hand-edited file still finds Mozilla.Firefox
  const ids = [...new Map(idsFromFile(json).filter((i) => typeof i === 'string' && PACKAGE_ID.test(i)).slice(0, MAX_IDS).map((i) => [i.toLowerCase(), i])).values()];
  const wanted = new Set(ids.map((i) => i.toLowerCase()));
  const known = flat().map((a) => a.id).filter((id) => wanted.has(id.toLowerCase()));
  return { canceled: false, read: ids.length, known, unknown: ids.length - known.length };
}

module.exports = { listCatalog, installFromCatalog, exportSelection, importSelection, idsFromFile, inCatalog, MAX_FILE_BYTES };
