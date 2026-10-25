const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listBlocked, parseEvent, buildRows, reasonOf, fromDevicePath, levelName, sacState, FETCH_SCRIPT, LOOKUP_SCRIPT, MAX_LOOKUPS } = require('./blocked');
const { execFileSync } = require('child_process');

// Real event records saved from this PC (computer name replaced): the NVIDIA overlay DLL refused by a Microsoft-only program (3033, with
// its 3089 signature companion), and a block of the packaged app by the application-control policy (3077) and the installer stub (3033).
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const NV33 = fx('ci-3033-nvspcap64.xml');
const NV89 = fx('ci-3089-nvspcap64.xml');
const WEB77 = fx('ci-3077-webase-exe.xml');
const SETUP33 = fx('ci-3033-webase-setup.xml');
const VOL = { C: '\\Device\\HarddiskVolume3', D: '\\Device\\HarddiskVolume6' };
const ev = (...xml) => xml.map(parseEvent);

test('a 3033 event is read by its named fields, with the time, the activity id and the levels', () => {
  const e = parseEvent(NV33);
  assert.equal(e.id, 3033);
  assert.equal(e.time, '2026-10-18T04:54:11.9703244Z');
  assert.equal(e.activity, 'f9db606c-5c9e-0003-59bf-05fa9e5cdd01');
  assert.equal(e.data.FileNameBuffer, '\\Device\\HarddiskVolume3\\Windows\\System32\\nvspcap64.dll');
  assert.equal(e.data.ProcessNameBuffer, '\\Device\\HarddiskVolume3\\Windows\\UUS\\amd64\\WaaSMedicAgent.exe');
  assert.deepEqual([e.data.RequestedPolicy, e.data.ValidatedPolicy], ['8', '1']);
  const s = parseEvent(NV89);
  assert.equal(s.id, 3089);
  assert.equal(s.data.PublisherName, 'NVIDIA Corporation');
  assert.equal(s.activity, e.activity);
});

test('a 3077 event uses different field names and carries the policy and the file\'s own product details', () => {
  const e = parseEvent(WEB77);
  assert.equal(e.id, 3077);
  assert.equal(e.data['File Name'], '\\Device\\HarddiskVolume6\\Web design\\webase test app\\webase-app\\release\\win-unpacked\\Webase System Monitor.exe');
  assert.equal(e.data['Requested Signing Level'], '2');
  assert.equal(e.data.PolicyName, 'VerifiedAndReputableDesktop');
  assert.equal(e.data.ProductName, 'Webase System Monitor');
  assert.equal(e.data.OriginalFileName, '', 'an empty field is read as empty');
});

test('XML entities in a path are decoded; broken or unrelated XML is ignored', () => {
  const e = parseEvent(NV33.replace('nvspcap64.dll', 'a&amp;b &lt;c&gt;.dll'));
  assert.equal(e.data.FileNameBuffer.endsWith('a&b <c>.dll'), true);
  for (const bad of ['', 'not xml', '<Event></Event>', '<Event><System><EventID>3033</EventID></System></Event>']) assert.equal(parseEvent(bad), null);
});

test('device paths become drive letters; an unknown volume keeps the device path', () => {
  assert.equal(fromDevicePath('\\Device\\HarddiskVolume3\\Windows\\x.dll', VOL), 'C:\\Windows\\x.dll');
  assert.equal(fromDevicePath('\\Device\\HarddiskVolume6\\Web design\\a.exe', VOL), 'D:\\Web design\\a.exe');
  assert.equal(fromDevicePath('\\Device\\HarddiskVolume9\\x.dll', VOL), '\\Device\\HarddiskVolume9\\x.dll');
  assert.equal(fromDevicePath('\\device\\harddiskvolume3\\x', VOL), 'C:\\x', 'case does not matter');
  assert.equal(fromDevicePath('C:\\Already\\a.exe', VOL), 'C:\\Already\\a.exe');
  assert.equal(fromDevicePath(null, VOL), null);
  assert.equal(fromDevicePath('\\Device\\HarddiskVolume3', VOL), 'C:\\');
});

test('the NVIDIA block becomes one row: a Microsoft-only program refused a file signed by NVIDIA', () => {
  const rows = buildRows(ev(NV33, NV89), VOL);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.file, r.process, r.kind, r.count], ['C:\\Windows\\System32\\nvspcap64.dll', 'C:\\Windows\\UUS\\amd64\\WaaSMedicAgent.exe', 'signing-level', 1]);
  assert.deepEqual([r.fileName, r.processName, r.needed, r.got, r.publisher], ['nvspcap64.dll', 'WaaSMedicAgent.exe', 'Microsoft', null, 'NVIDIA Corporation']);
  r.reason = reasonOf(r);
  assert.match(r.reason, /WaaSMedicAgent\.exe only accepts files signed by Microsoft, and refused nvspcap64\.dll/);
  assert.match(r.reason, /signed by NVIDIA Corporation/);
  assert.match(r.reason, /may be fine/);
});

test('an enforced block is a policy row, names the policy as Windows logged it, and merges a 3033 for the same file and program', () => {
  const as3033 = WEB77.replace('<EventID>3077</EventID>', '<EventID>3033</EventID>');
  const rows = buildRows(ev(as3033, WEB77), VOL);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, 'policy');
  assert.equal(r.count, 1, 'the 3033 and 3077 of one attempt are one block, counted by the enforcing event');
  assert.deepEqual([r.policy, r.needed, r.got, r.product], ['VerifiedAndReputableDesktop', 'Enterprise', 'unsigned', 'Webase System Monitor']);
  assert.equal(r.file, 'D:\\Web design\\webase test app\\webase-app\\release\\win-unpacked\\Webase System Monitor.exe');
  r.reason = reasonOf(r);
  assert.match(r.reason, /app control blocked Webase System Monitor\.exe/);
  assert.match(r.reason, /policy "VerifiedAndReputableDesktop", named like the policy Smart App Control uses/);
  assert.match(r.reason, /node\.exe tried to start or load it/);
});

test('a lone 3033 that asks for a weaker level is not called a Microsoft-only rule', () => {
  const [r] = buildRows(ev(SETUP33), VOL);
  assert.equal(r.kind, 'signing-level');
  assert.equal(r.needed, 'Enterprise');
  assert.match(reasonOf(r), /requires files signed at the Enterprise level, and Webase-System-Monitor-Setup-0\.0\.0\.exe did not meet that/);
  assert.doesNotMatch(reasonOf(r), /only accepts/);
});

test('repeats are counted, first and last time are kept, and the newest row comes first', () => {
  const later = NV33.replace('2026-10-18T04:54:11.9703244Z', '2026-10-25T03:10:10.9460000Z');
  const rows = buildRows(ev(NV33, later, NV33, WEB77), VOL);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fileName, 'Webase System Monitor.exe', 'the 25 October 15:04 block is newer than the 25 October 03:10 one');
  const nv = rows[1];
  assert.deepEqual([nv.count, nv.first, nv.last], [3, '2026-10-18T04:54:11.970Z', '2026-10-25T03:10:10.946Z']);
});

test('audit events are marked as would-be blocks, and events without a file are skipped', () => {
  const audit = WEB77.replace('<EventID>3077</EventID>', '<EventID>3076</EventID>');
  const [r] = buildRows(ev(audit), VOL);
  assert.equal(r.kind, 'audit');
  assert.match(reasonOf(r), /would block .* \(audit only/);
  assert.deepEqual(buildRows(ev(NV89), VOL), [], 'a signature companion alone is not a block');
  assert.deepEqual(buildRows([], VOL), []);
});

test('"Unknown", which Windows logs as the publisher of an unsigned file, is not shown as a company', () => {
  const unsigned89 = NV89.replace('<Data Name=\'PublisherName\'>NVIDIA Corporation</Data>', '<Data Name=\'PublisherName\'>Unknown</Data>');
  assert.notEqual(unsigned89, NV89, 'the fixture was changed');
  const [r] = buildRows(ev(NV33, unsigned89), VOL);
  assert.equal(r.publisher, null);
  assert.doesNotMatch(reasonOf(r), /signed by Unknown|It is signed by/);
});

test('levels and the Smart App Control state have plain names', () => {
  assert.deepEqual([levelName(1), levelName(2), levelName(8), levelName(12), levelName(77), levelName(null), levelName(NaN)], ['unsigned', 'Enterprise', 'Microsoft', 'Windows', 'level 77', null, null]);
  assert.deepEqual([1, 2, 0, null, 5].map((v) => sacState(v).state), ['on', 'evaluation', 'off', 'unknown', 'unknown']);
  assert.match(sacState(1).text, /blocks apps it cannot confirm are safe/);
});

test('the whole list: rows get the file\'s details and signature, the state is shown, and a failing lookup does not lose the rows', async () => {
  const raw = { volumes: VOL, events: [NV33, NV89, WEB77], oldest: '2026-10-18T04:50:00.000Z', sac: 1 };
  const calls = [];
  const out = await listBlocked({
    fetch: async () => raw,
    lookup: async (files) => { calls.push(files); return files.map((f) => (/nvspcap64/.test(f) ? { file: f, exists: true, product: 'NVIDIA App', description: 'NVIDIA Game Proxy', company: 'NVIDIA Corporation', version: '11.0.9.565', status: 'Valid', signer: 'NVIDIA Corporation' } : { file: f, exists: false })); },
  });
  assert.equal(out.sac.state, 'on');
  assert.equal(out.oldest, '2026-10-18T04:50:00.000Z');
  assert.equal(out.eventCount, 2, 'the 3089 companion is not counted as a block');
  assert.equal(out.rows.length, 2);
  const nv = out.rows.find((r) => r.fileName === 'nvspcap64.dll');
  assert.deepEqual([nv.exists, nv.product, nv.company, nv.signature, nv.signer], [true, 'NVIDIA App', 'NVIDIA Corporation', 'valid', 'NVIDIA Corporation']);
  assert.match(nv.reason, /refused nvspcap64\.dll/);
  const web = out.rows.find((r) => r.fileName === 'Webase System Monitor.exe');
  assert.deepEqual([web.exists, web.product], [false, 'Webase System Monitor'], 'details from the log are kept when the file is gone');
  assert.deepEqual(calls[0].sort(), ['C:\\Windows\\System32\\nvspcap64.dll', 'D:\\Web design\\webase test app\\webase-app\\release\\win-unpacked\\Webase System Monitor.exe'].sort());

  const noLookup = await listBlocked({ fetch: async () => raw, lookup: async () => { throw new Error('boom'); } });
  assert.equal(noLookup.rows.length, 2);
  assert.ok(noLookup.rows.every((r) => r.reason.length > 20));
});

test('an empty or unreadable log gives an empty list, never a crash; lookups are capped and only for real drive paths', async () => {
  assert.deepEqual((await listBlocked({ fetch: async () => ({ volumes: VOL, events: [], oldest: null, sac: null }), lookup: async () => [] })).rows, []);
  assert.equal((await listBlocked({ fetch: async () => null, lookup: async () => [] })).sac.state, 'unknown');
  const many = Array.from({ length: 60 }, (_, i) => NV33.replace('nvspcap64.dll', `f${i}.dll`).replace('2026-10-18T04:54:11.9703244Z', `2026-10-18T05:${String(i).padStart(2, '0')}:00.0000000Z`));
  let asked = 0;
  await listBlocked({ fetch: async () => ({ volumes: VOL, events: [...many, NV33.replace('\\Device\\HarddiskVolume3\\Windows\\System32\\nvspcap64.dll', '\\Device\\Mup\\server\\share\\x.dll')], sac: 1 }), lookup: async (files) => { asked = files.length; assert.ok(files.every((f) => /^[A-Z]:\\/.test(f))); return []; } });
  assert.equal(asked, MAX_LOOKUPS);
});

// The two read-only system scripts, run for real
const psOut = (script, env = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();

test('the real fetch script returns the volumes, the events as XML strings, and the Smart App Control value', () => {
  const j = JSON.parse(psOut(FETCH_SCRIPT));
  assert.match(j.volumes.C, /^\\Device\\/, 'C: maps to a device path');
  assert.ok(Array.isArray(j.events));
  for (const x of j.events.slice(0, 20)) assert.ok(parseEvent(x), 'every returned event parses');
  assert.ok(j.sac === null || [0, 1, 2].includes(j.sac), `sac: ${j.sac}`);
});

test('the real lookup script handles one file and several, an existing system file and a missing one', () => {
  const run = (files) => [].concat(JSON.parse(psOut(LOOKUP_SCRIPT, { WB_FILES: JSON.stringify(files) })));
  const notepad = path.join(process.env.SystemRoot, 'System32', 'notepad.exe');
  const one = run([notepad]);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].exists, one[0].status, /microsoft/i.test(one[0].signer)], [true, 'Valid', true]);
  const two = run([notepad, 'C:\\definitely-missing\\nothing.dll']);
  assert.deepEqual(two.map((x) => x.exists), [true, false]);
});
