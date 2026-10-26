const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getBattery, batteryReport, readNow, parseReport, isoMinutes, healthPct, NOW_SCRIPT, _reset } = require('./battery');

// The real battery report from this PC (computer name, battery id, serial number and report id replaced).
const REPORT = fs.readFileSync(path.join(__dirname, 'fixtures', 'battery-report.xml'), 'utf8');
test.beforeEach(() => _reset());

const raw = (over = {}) => ({ present: true, count: 1, percent: 80, runMin: 71582788, powerOnline: true, charging: false, discharging: false, critical: false, remainingMwh: 46888, chargeMw: 0, dischargeMw: 0, voltageMv: 17266, fullMwh: 58610, cycles: 33, ...over });
const DESIGN = { designMwh: 60000, relative: false };

test('ISO durations become minutes; anything else is null', () => {
  assert.equal(isoMinutes('P2DT3H53M18S'), 3113.3);
  assert.equal(isoMinutes('PT0S'), 0);
  assert.equal(isoMinutes('PT1H37M30S'), 97.5);
  assert.equal(isoMinutes('P1DT18H16M23S'), 2536.4);
  assert.equal(isoMinutes('PT3M15S'), 3.3);
  for (const bad of ['', 'P', 'PT', 'T1H', '1H', 'PT1X', null, undefined, 5, 'p1d']) assert.equal(isoMinutes(bad), null, String(bad));
});

test('health is full-charge over design to one decimal; unknown or zero design is null; above 100 is allowed', () => {
  assert.equal(healthPct(58610, 60000), 97.7);
  assert.equal(healthPct(60000, 60000), 100);
  assert.equal(healthPct(63000, 60000), 105);
  for (const [f, d] of [[58610, 0], [58610, null], [null, 60000], [undefined, undefined], [58610, 0xffffffff], [0xffffffff, 60000], [-1, 60000], ['x', 60000]]) assert.equal(healthPct(f, d), null, `${f} / ${d}`);
  assert.equal(healthPct(0, 60000), 0);
});

test('the real report: the battery, Windows\' run-time estimates and ten periods of history, newest first, with dates as the report wrote them', () => {
  const r = parseReport(REPORT);
  assert.deepEqual(r.battery, { manufacturer: 'BYD', chemistry: 'Lithium polymer', relative: false, designMwh: 60000, fullMwh: 58610, cycles: 33, health: 97.7 });
  assert.equal(r.count, 1);
  assert.equal(r.scanTime, '2026-10-26T23:10:36');
  assert.deepEqual(r.runtime, { fullActiveMin: 97.5, fullStandbyMin: 679.2, designActiveMin: 99.8, designStandbyMin: 695.3 });
  assert.equal(r.history.length, 10);
  const oldest = r.history.at(-1);
  assert.deepEqual([oldest.from, oldest.to, oldest.fullMwh, oldest.designMwh, oldest.health, oldest.cycles], ['2026-10-10T09:01:21', '2026-10-17T09:01:21', 58610, 60000, 97.7, 32]);
  assert.deepEqual([oldest.activeAcMin, oldest.activeBatteryMin, oldest.standbyAcMin, oldest.standbyBatteryMin], [3113.3, 0, 2536.4, 3.3]);
  const newest = r.history[0];
  assert.equal(newest.from, '2026-10-25T00:00:00');
  assert.equal(newest.to, '2026-10-25T23:59:59', 'the local text as written, not converted from UTC');
  assert.deepEqual(r.history.map((h) => h.from), [...r.history.map((h) => h.from)].sort().reverse(), 'newest first');
  assert.ok(r.history.every((h) => h.health === null || (h.health > 50 && h.health <= 105)));
});

test('what the window gets from the report has no serial number, battery id, computer name or path', async () => {
  const r = await batteryReport({ runReport: async () => REPORT });
  const text = JSON.stringify(r);
  for (const secret of ['TESTBATT01', '0000', 'TEST-PC', '00000000-0000', 'C:\\', 'Serial', 'Id']) assert.ok(!text.includes(secret) || secret === '0000' && !/"0000"/.test(text), secret);
  assert.equal(r.present, true);
  assert.equal(r.battery.health, 97.7);
  assert.equal(r.history.length, 10);
});

test('a battery that reports relative capacities gets percentages only: no mWh, no power, no time-left maths', async () => {
  const relative = REPORT.replace('<RelativeCapacity>0</RelativeCapacity>', '<RelativeCapacity>1</RelativeCapacity>');
  const r = await batteryReport({ runReport: async () => relative });
  assert.equal(r.relative, true);
  assert.deepEqual([r.battery.designMwh, r.battery.fullMwh, r.battery.health, r.battery.cycles], [null, null, 97.7, 33]);
  assert.ok(r.history.every((h) => h.designMwh === null && h.fullMwh === null && h.health !== undefined));
  const now = readNow(raw({ discharging: true, powerOnline: false, runMin: 71582788, dischargeMw: 12000 }), { designMwh: 60000, relative: true });
  assert.deepEqual([now.relative, now.remainingMwh, now.fullMwh, now.designMwh, now.powerW, now.minutesLeft, now.estimating, now.health], [true, null, null, null, null, null, true, 97.7]);
});

test('no battery, a malformed report and a missing report all end as "no battery", never as an error for the window', async () => {
  assert.deepEqual(readNow({ present: false }), { present: false });
  assert.deepEqual(readNow(null), { present: false });
  assert.deepEqual(readNow({}), { present: false });
  assert.equal(parseReport('<BatteryReport></BatteryReport>'), null);
  assert.equal(parseReport(''), null);
  assert.equal(parseReport(undefined), null);
  assert.deepEqual(await batteryReport({ runReport: async () => '<nothing/>' }), { present: false });
  // powercfg refuses on a PC with no battery: the live read says so
  assert.deepEqual(await batteryReport({ runReport: async () => { throw new Error('exit 1'); }, nowRaw: async () => ({ present: false }) }), { present: false });
  // but a failure on a PC that does have one is a plain error
  await assert.rejects(() => batteryReport({ runReport: async () => { throw new Error('boom'); }, nowRaw: async () => raw() }), /could not make the battery report/);
  await assert.rejects(() => batteryReport({ runReport: async () => { throw new Error('boom'); }, nowRaw: async () => { throw new Error('wmi'); } }), /could not make the battery report/);
});

test('states: charging, on battery, full on AC, plugged in but not charging (neutral), and unknown', () => {
  const s = (over) => readNow(raw(over), DESIGN);
  assert.equal(s({ charging: true, chargeMw: 45000, powerOnline: true }).state, 'charging');
  assert.equal(s({ charging: true, chargeMw: 45000 }).powerW, 45);
  assert.equal(s({ discharging: true, powerOnline: false, dischargeMw: 12000 }).state, 'discharging');
  assert.equal(s({ percent: 100, remainingMwh: 58610 }).state, 'full');
  assert.equal(s({ percent: 99 }).state, 'full');
  assert.equal(s({ percent: 80 }).state, 'plugged', 'plugged in, not charging at 80 %: a battery-care setting can do this, it is not a fault');
  assert.equal(s({ powerOnline: false, discharging: false }).state, 'discharging', 'no power cable means it runs on the battery');
  assert.equal(s({ powerOnline: null, charging: null, discharging: null }).state, 'unknown');
  assert.equal(s({ percent: undefined, remainingMwh: 29305, fullMwh: 58610 }).percent, 50, 'the percent can come from the capacities');
  assert.equal(s({ percent: 140 }).percent, 100);
  assert.equal(s({ critical: true }).critical, true);
});

test('time left: Windows\' own estimate first; otherwise remaining over the drain rate; unknown or stale numbers say "estimating"', () => {
  const on = (over) => readNow(raw({ discharging: true, powerOnline: false, ...over }), DESIGN);
  assert.deepEqual([on({ runMin: 95 }).minutesLeft, on({ runMin: 95 }).estimating], [95, false]);
  assert.deepEqual([on({ runMin: 71582788, dischargeMw: 12000, remainingMwh: 46888 }).minutesLeft], [234], '46.9 Wh at 12 W is about 3 h 54 min');
  for (const stale of [{ dischargeMw: 0 }, { dischargeMw: 0x80000000 }, { dischargeMw: null }, { dischargeMw: 0xffffffff }, { remainingMwh: 0xffffffff, dischargeMw: 12000 }, { dischargeMw: -5 }]) {
    const r = on({ runMin: 71582788, ...stale });
    assert.deepEqual([r.minutesLeft, r.estimating], [null, true], JSON.stringify(stale));
  }
  assert.equal(on({ runMin: 0, dischargeMw: 12000 }).minutesLeft, 234, 'a zero estimate is not an estimate');
  assert.equal(on({ runMin: 99999999 }).minutesLeft, null);
  assert.equal(readNow(raw({ charging: true }), DESIGN).estimating, false, 'only a discharging battery is "estimating"');
  assert.equal(readNow(raw({ percent: 100 }), DESIGN).minutesLeft, null, 'no time left while on AC');
});

test('unknown values from the battery become null: rates 0x80000000, capacities and voltage 0xFFFFFFFF, and the run-time sentinel', () => {
  const r = readNow(raw({ remainingMwh: 0xffffffff, fullMwh: 0xffffffff, voltageMv: 0xffffffff, chargeMw: 0x80000000, dischargeMw: 0x80000000, cycles: 0xffffffff, percent: undefined }), DESIGN);
  assert.deepEqual([r.remainingMwh, r.fullMwh, r.voltageV, r.powerW, r.cycles, r.health, r.percent], [null, null, null, null, null, null, null]);
  const ok = readNow(raw(), DESIGN);
  assert.deepEqual([ok.voltageV, ok.remainingMwh, ok.fullMwh, ok.designMwh, ok.cycles, ok.health, ok.percent], [17.27, 46888, 58610, 60000, 33, 97.7, 80]);
  assert.equal(readNow(raw({ cycles: 0 }), DESIGN).cycles, 0, 'zero cycles is a real number');
  assert.equal(readNow(raw(), {}).health, null, 'without the design capacity the health is unknown');
  assert.equal(readNow(raw({ count: 2 }), DESIGN).count, 2);
  assert.equal(readNow(raw({ count: undefined }), DESIGN).count, 1);
});

test('what the window gets for "now" never carries the battery name, id, serial number or device id', () => {
  const polluted = { ...raw(), Name: 'L23B4PK4', DeviceID: '2524BYDL23B4PK4', name: 'L23B4PK4', deviceId: '2524BYDL23B4PK4', serial: '2524', InstanceName: 'ACPI\\PNP0C0A\\2_0' };
  const text = JSON.stringify(readNow(polluted, DESIGN));
  for (const secret of ['L23B4PK4', '2524', 'ACPI', 'PNP0C0A']) assert.ok(!text.includes(secret), secret);
  assert.ok(!NOW_SCRIPT.includes('DeviceID') && !/\bName\b\s*=/.test(NOW_SCRIPT.replace(/\$name\b/g, '')), 'the script never reads Win32_Battery.Name or DeviceID');
});

test('the design capacity comes from the first report and is kept; a failing report leaves health unknown without failing the read', async () => {
  let reports = 0;
  const deps = { nowRaw: async () => raw(), runReport: async () => { reports++; return REPORT; } };
  const a = await getBattery(deps);
  assert.deepEqual([a.health, a.designMwh, a.cycles], [97.7, 60000, 33]);
  await getBattery(deps);
  await getBattery(deps);
  assert.equal(reports, 1, 'the report was read once, not on every poll');
  _reset();
  const broken = await getBattery({ nowRaw: async () => raw(), runReport: async () => { throw new Error('x'); } });
  assert.deepEqual([broken.present, broken.health, broken.percent], [true, null, 80]);
  _reset();
  assert.deepEqual(await getBattery({ nowRaw: async () => ({ present: false }), runReport: async () => { throw new Error('must not run'); } }), { present: false });
});

test('only one report runs at a time, and the temp file of the real run is gone afterwards', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { runReport: async () => { runs++; await gate; return REPORT; } };
  const a = batteryReport(slow);
  const b = batteryReport(slow);
  release();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(runs, 1);
  assert.deepEqual(x, y);
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('webase-battery-')).length;
  try {
    await batteryReport(); // the real powercfg, whether or not this PC has a battery
  } catch {
    // a desktop (or no powercfg) may refuse; the file must be gone either way
  }
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('webase-battery-')).length, before);
});

// The real system script, read-only
test('the real "now" script returns JSON that readNow understands, on a laptop or a desktop', () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', NOW_SCRIPT], { encoding: 'utf8', windowsHide: true }).trim();
  const j = JSON.parse(out);
  assert.equal(typeof j.present, 'boolean');
  const r = readNow(j, DESIGN);
  assert.equal(r.present, j.present);
  if (r.present) {
    assert.ok(r.percent === null || (r.percent >= 0 && r.percent <= 100), String(r.percent));
    assert.ok(['charging', 'discharging', 'full', 'plugged', 'unknown'].includes(r.state));
    assert.ok(r.cycles === null || r.cycles >= 0);
    assert.ok(!('Name' in j) && !('DeviceID' in j), 'the script returns neither the battery name nor its device id');
  }
});
