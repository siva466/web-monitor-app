const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CATALOG } = require('./catalog-data');
const { listCatalog, installFromCatalog, exportSelection, importSelection, idsFromFile, inCatalog, MAX_FILE_BYTES } = require('./catalog');
const { PACKAGE_ID } = require('./winget');

const ids = CATALOG.flatMap((c) => c.apps.map((a) => a.id));
const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'webase-catalog-test-'));
  dirs.push(d);
  return d;
};
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('the catalog is well formed: real-looking ids, no repeats (even by case), names, notes, no empty category', () => {
  assert.ok(CATALOG.length >= 8 && ids.length >= 60, `${CATALOG.length} categories, ${ids.length} apps`);
  assert.ok(ids.every((id) => PACKAGE_ID.test(id)), 'every id passes the package-id pattern');
  assert.equal(new Set(ids.map((i) => i.toLowerCase())).size, ids.length, 'no id twice');
  assert.ok(CATALOG.every((c) => c.name && c.apps.length > 0));
  assert.ok(CATALOG.flatMap((c) => c.apps).every((a) => a.name.length > 1 && a.note.length > 8 && a.note.length < 90), 'names and short notes');
  assert.equal(new Set(CATALOG.map((c) => c.name)).size, CATALOG.length);
});

test('things that must never be offered are not in the catalog', () => {
  const lower = ids.map((i) => i.toLowerCase());
  for (const banned of ['teamviewer', 'anydesk', 'rustdesk', 'ccleaner', 'winrar', 'docker', 'piriform']) assert.ok(!lower.some((i) => i.includes(banned)), banned);
});

const list = (rows) => async () => rows;
const row = (id, version = '1.0', available = null) => ({ name: id, id, version, available });

test('each app is installed, installed with an update, or missing, by id (any letter case); unknown programs on the PC are ignored', async () => {
  const r = await listCatalog({ listInstalled: list([row('7zip.7zip', '26.05'), row('MOZILLA.FIREFOX', '140', '141'), row('Not.InCatalog'), row('ARP\\Machine\\X64\\Something')]) });
  const all = r.categories.flatMap((c) => c.apps);
  const by = (id) => all.find((a) => a.id === id);
  assert.deepEqual([by('7zip.7zip').state, by('7zip.7zip').version, by('7zip.7zip').available], ['installed', '26.05', null]);
  assert.deepEqual([by('Mozilla.Firefox').state, by('Mozilla.Firefox').version, by('Mozilla.Firefox').available], ['update', '140', '141']);
  assert.equal(by('Valve.Steam').state, 'missing');
  assert.equal(all.length, ids.length);
  assert.deepEqual(r.categories.map((c) => c.name), CATALOG.map((c) => c.name));
  assert.ok(all.every((a) => a.id && a.name && a.note && ['installed', 'update', 'missing'].includes(a.state)));
  assert.ok(Number.isFinite(r.checkedAt));
  const none = await listCatalog({ listInstalled: list([]) });
  assert.ok(none.categories.every((c) => c.apps.every((a) => a.state === 'missing' && a.version === null)));
});

test('only an app from the catalog can be installed from here', async () => {
  const seen = [];
  const deps = { installApp: async (id) => { seen.push(id); return { id, installed: true }; } };
  assert.equal((await installFromCatalog('Mozilla.Firefox', deps)).installed, true);
  assert.deepEqual(seen, ['Mozilla.Firefox']);
  for (const bad of ['Evil.Package', 'mozilla.firefox ', '', '-h', 'Mozilla.Firefox --version 1', null, undefined, 7, ['Mozilla.Firefox'], { id: 'Mozilla.Firefox' }]) {
    assert.throws(() => installFromCatalog(bad, deps), /not in the catalog/, JSON.stringify(bad));
  }
  assert.deepEqual(seen, ['Mozilla.Firefox'], 'nothing else reached the installer');
  assert.equal(inCatalog('Git.Git'), true);
  assert.equal(inCatalog('git.git'), false, 'installs use the exact catalog spelling');
});

test('saving: only catalog ids, once each and in catalog order, to the file the person chose; cancelling writes nothing', async () => {
  const d = tmp();
  const file = path.join(d, 'mine.json');
  let asked;
  const r = await exportSelection(['Git.Git', 'Mozilla.Firefox', 'Git.Git', '7zip.7zip'], { showSave: async (name) => { asked = name; return file; }, now: () => new Date('2026-10-26T09:00:00Z') });
  assert.deepEqual([r.saved, r.name, r.count, asked], [true, 'mine.json', 3, 'webase-apps.json']);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([j.format, j.version, j.created], ['webase-apps', 1, '2026-10-26T09:00:00.000Z']);
  const order = (id) => ids.indexOf(id);
  assert.deepEqual(j.apps, ['Mozilla.Firefox', '7zip.7zip', 'Git.Git'].sort((a, b) => order(a) - order(b)));
  const cancelled = path.join(d, 'never.json');
  assert.deepEqual(await exportSelection(['Git.Git'], { showSave: async () => null }), { saved: false });
  assert.ok(!fs.existsSync(cancelled));
  assert.equal(r.name.includes(path.sep), false, 'only a file name goes back to the window');
});

test('saving refuses anything that is not a short list of catalog ids, before any dialog opens', async () => {
  let opened = 0;
  const showSave = async () => { opened++; return null; };
  for (const bad of [undefined, null, 'Git.Git', [], [1], [null], ['Git.Git', 'Evil.Package'], ['git.git'], new Array(501).fill('Git.Git'), [{}]]) {
    await assert.rejects(() => exportSelection(bad, { showSave }), /Nothing is selected|not in the catalog/, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal(opened, 0);
});

const fileWith = (text, d = tmp()) => {
  const f = path.join(d, 'list.json');
  fs.writeFileSync(f, text);
  return f;
};
const open = (f) => ({ showOpen: async () => f });

test('opening a list: our own format and a `winget export` file both work; only catalog ids come back, the rest are counted', async () => {
  const ours = await importSelection(open(fileWith(JSON.stringify({ format: 'webase-apps', version: 1, apps: ['Git.Git', 'Mozilla.Firefox', 'Some.Unknown', 'Git.Git'] }))));
  assert.deepEqual(ours, { canceled: false, read: 3, known: ['Mozilla.Firefox', 'Git.Git'].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)), unknown: 1 });
  const exported = { '$schema': 'https://aka.ms/winget-packages.schema.2.0.json', Sources: [{ Packages: [{ PackageIdentifier: 'VideoLAN.VLC' }, { PackageIdentifier: 'Other.App' }, { PackageIdentifier: 'Valve.Steam' }], SourceDetails: { Name: 'winget' } }, { Packages: [{ PackageIdentifier: 'Notepad++.Notepad++' }] }] };
  const w = await importSelection(open(fileWith(JSON.stringify(exported))));
  assert.deepEqual([w.read, w.unknown], [4, 1]);
  assert.deepEqual([...w.known].sort(), ['Notepad++.Notepad++', 'Valve.Steam', 'VideoLAN.VLC']);
});

test('opening a list: ids are matched whatever their letter case, and a byte-order mark is fine', async () => {
  const r = await importSelection(open(fileWith('﻿' + JSON.stringify({ apps: ['mozilla.firefox', 'GIT.GIT', 'MOZILLA.FIREFOX'] }))));
  assert.deepEqual([r.read, r.unknown], [2, 0]);
  assert.deepEqual([...r.known].sort(), ['Git.Git', 'Mozilla.Firefox']);
});

test('opening a list: junk in the file is ignored, wrong shapes and big files are refused, cancelling is not an error', async () => {
  const junk = await importSelection(open(fileWith(JSON.stringify({ apps: [1, null, {}, ['Git.Git'], 'a b', '-x', 'x'.repeat(200), '..\\x', 'Git.Git'] }))));
  assert.deepEqual([junk.read, junk.known, junk.unknown], [1, ['Git.Git'], 0]);
  await assert.rejects(() => importSelection(open(fileWith('not json'))), /not valid JSON/);
  await assert.rejects(() => importSelection(open(fileWith('{"hello": 1}'))), /not a list of apps/);
  await assert.rejects(() => importSelection(open(fileWith('[1,2]'))), /not a list of apps/);
  await assert.rejects(() => importSelection(open(fileWith('null'))), /not a list of apps/);
  await assert.rejects(() => importSelection(open(fileWith(JSON.stringify({ apps: ['Git.Git'], pad: 'x'.repeat(MAX_FILE_BYTES) })))), /small JSON list/);
  await assert.rejects(() => importSelection(open(tmp())), /small JSON list/, 'a folder is not a file');
  assert.deepEqual(await importSelection({ showOpen: async () => null }), { canceled: true });
});

test('opening a list: only the first 2000 ids are looked at', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => `Fake.App${i}`);
  const r = await importSelection(open(fileWith(JSON.stringify({ apps: [...many, 'Git.Git'] }))));
  assert.deepEqual([r.read, r.known, r.unknown], [2000, [], 2000]);
});

test('the id lists of both file formats are read the same way', () => {
  assert.deepEqual(idsFromFile({ apps: ['a'] }), ['a']);
  assert.deepEqual(idsFromFile({ Sources: [{ Packages: [{ PackageIdentifier: 'a' }, null, {}] }, null, { Packages: 'x' }] }), ['a', undefined, undefined]);
  for (const bad of [null, undefined, 1, 'x', [], {}, { apps: 'x' }, { Sources: 'x' }]) assert.throws(() => idsFromFile(bad), /not a list of apps/, JSON.stringify(bad));
});
