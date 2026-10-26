const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// The laptop battery: what it is doing now (WMI) and how healthy it is (Windows' own battery report). Read-only, no administrator rights.
// The window receives numbers and words only: never the battery's id or serial number, the computer name, or a path.
// Not used: systeminformation's battery() (on the PC this was built on it reports 0 cycles where the real count is 33).

const UNKNOWN_RUNTIME = 71582788; // Win32_Battery's "unknown" run time, in minutes
const UNKNOWN_RATE = 0x80000000; // BatteryStatus: a rate the battery cannot say
const UNKNOWN_U32 = 0xffffffff; // BatteryStatus: a capacity or voltage the battery cannot say

// One run: Win32_Battery plus the three root\wmi classes, the latter matched to the FIRST battery by InstanceName so two batteries' numbers are
// never mixed. Name and DeviceID are never read (they contain the battery's id and serial number).
const NOW_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$w = @(Get-CimInstance Win32_Battery)
if ($w.Count -eq 0) { '{"present":false}'; exit 0 }
$first = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus | Select-Object -First 1
$name = $first.InstanceName
$full = Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity | Where-Object { $_.InstanceName -eq $name } | Select-Object -First 1
$cyc = Get-CimInstance -Namespace root\wmi -ClassName BatteryCycleCount | Where-Object { $_.InstanceName -eq $name } | Select-Object -First 1
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ present = $true; count = $w.Count; percent = $w[0].EstimatedChargeRemaining; runMin = $w[0].EstimatedRunTime; powerOnline = $first.PowerOnline; charging = $first.Charging; discharging = $first.Discharging; critical = $first.Critical; remainingMwh = $first.RemainingCapacity; chargeMw = $first.ChargeRate; dischargeMw = $first.DischargeRate; voltageMv = $first.Voltage; fullMwh = $full.FullChargedCapacity; cycles = $cyc.CycleCount })
`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v !== UNKNOWN_U32 && v !== UNKNOWN_RATE && v >= 0 ? v : null);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Full-charge capacity as a percent of the design capacity, one decimal; null when either is unknown. May be above 100 for a new battery.
function healthPct(full, design) {
  const f = num(full);
  const d = num(design);
  return f === null || d === null || d <= 0 ? null : Math.round((f / d) * 1000) / 10;
}

// Raw WMI numbers -> what the window shows. `design`: { designMwh, relative } from the last report (relative = the battery reports capacities in
// relative units, so milliwatt-hour, power and time-left figures mean nothing and only percentages are given).
function readNow(raw, design = {}) {
  if (!raw || raw.present !== true) return { present: false };
  const relative = design.relative === true;
  const remaining = num(raw.remainingMwh);
  const full = num(raw.fullMwh);
  const percent = num(raw.percent) !== null ? clamp(Math.round(raw.percent), 0, 100) : remaining !== null && full ? clamp(Math.round((remaining / full) * 100), 0, 100) : null;
  const ac = raw.powerOnline === true ? true : raw.powerOnline === false ? false : null;
  let state = 'unknown';
  if (raw.charging === true) state = 'charging';
  else if (raw.discharging === true) state = 'discharging';
  else if (ac === true) state = percent !== null && percent >= 99 ? 'full' : 'plugged'; // plugged in, not charging (full, or held back by a battery-care setting)
  else if (ac === false) state = 'discharging';

  const chargeMw = num(raw.chargeMw);
  const dischargeMw = num(raw.dischargeMw);
  let minutesLeft = null;
  if (state === 'discharging') {
    const windows = num(raw.runMin);
    if (windows !== null && windows > 0 && windows !== UNKNOWN_RUNTIME && windows < 100000) minutesLeft = Math.round(windows);
    else if (!relative && dischargeMw !== null && dischargeMw > 0 && remaining !== null) minutesLeft = Math.round((remaining / dischargeMw) * 60);
  }
  const volts = num(raw.voltageMv);
  return {
    present: true,
    count: Number.isInteger(raw.count) && raw.count > 0 ? raw.count : 1,
    percent,
    state,
    acOnline: ac,
    critical: raw.critical === true,
    minutesLeft,
    estimating: state === 'discharging' && minutesLeft === null, // just unplugged: the rate is 0 or stale for a few seconds
    relative,
    powerW: relative ? null : state === 'charging' && chargeMw !== null ? chargeMw / 1000 : state === 'discharging' && dischargeMw !== null && dischargeMw > 0 ? -dischargeMw / 1000 : null,
    voltageV: volts === null ? null : Math.round(volts / 10) / 100,
    remainingMwh: relative ? null : remaining,
    fullMwh: relative ? null : full,
    designMwh: relative ? null : num(design.designMwh),
    cycles: num(raw.cycles),
    health: healthPct(raw.fullMwh, design.designMwh),
  };
}

// ---- the battery report (powercfg /batteryreport /xml) ----

const decodeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// "P2DT3H53M18S" -> minutes (3113.3). null when it is not a duration.
function isoMinutes(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s ?? ''));
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined)) return null;
  return Math.round(((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60) * 10) / 10;
}

const CHEMISTRY = { lipb: 'Lithium polymer', lion: 'Lithium-ion', 'li-ion': 'Lithium-ion', pbac: 'Lead acid', nicd: 'Nickel-cadmium', nimh: 'Nickel-metal hydride', nizn: 'Nickel-zinc', ram: 'Rechargeable alkaline manganese' };

// The report is machine-written and regular (its elements and attributes are fixed by Microsoft's schema), so the few things needed are read
// directly instead of pulling in an XML library. Dates stay as the report wrote them (local time), never converted. The battery's id and serial
// number are not read.
function parseReport(xml) {
  const text = String(xml ?? '');
  const tag = (s, name) => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(s);
    return m ? decodeXml(m[1]).trim() : null;
  };
  const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const first = /<Battery>([\s\S]*?)<\/Battery>/.exec(text)?.[1];
  if (!first) return null;
  const count = [...text.matchAll(/<Battery>/g)].length;
  const chem = tag(first, 'Chemistry');
  const battery = {
    manufacturer: tag(first, 'Manufacturer') || null,
    chemistry: chem ? CHEMISTRY[chem.toLowerCase()] ?? chem : null,
    relative: tag(first, 'RelativeCapacity') === '1',
    designMwh: n(tag(first, 'DesignCapacity')),
    fullMwh: n(tag(first, 'FullChargeCapacity')),
    cycles: n(tag(first, 'CycleCount')),
  };
  battery.health = healthPct(battery.fullMwh, battery.designMwh);

  const est = /<RuntimeEstimates>([\s\S]*?)<\/RuntimeEstimates>/.exec(text)?.[1];
  const part = (name) => {
    const s = est ? new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(est)?.[1] : null;
    return s ? { active: isoMinutes(tag(s, 'ActiveRuntime')), standby: isoMinutes(tag(s, 'ConnectedStandbyRuntime')) } : null;
  };
  const atFull = part('FullChargeCapacity');
  const runtime = atFull ? { fullActiveMin: atFull.active, fullStandbyMin: atFull.standby, designActiveMin: part('DesignCapacity')?.active ?? null, designStandbyMin: part('DesignCapacity')?.standby ?? null } : null;

  const history = [...text.matchAll(/<HistoryEntry\s([^>]*?)\/>/g)].map((m) => {
    const a = Object.fromEntries([...m[1].matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)].map((x) => [x[1], x[2]]));
    return {
      from: a.LocalStartDate ?? null,
      to: a.LocalEndDate ?? null,
      designMwh: n(a.DesignCapacity),
      fullMwh: n(a.FullChargeCapacity),
      health: healthPct(n(a.FullChargeCapacity), n(a.DesignCapacity)),
      cycles: n(a.CycleCount),
      activeBatteryMin: isoMinutes(a.ActiveDcTime),
      standbyBatteryMin: isoMinutes(a.CsDcTime),
      activeAcMin: isoMinutes(a.ActiveAcTime),
      standbyAcMin: isoMinutes(a.CsAcTime),
    };
  }).filter((h) => h.from && h.to);
  history.reverse(); // newest first

  return { scanTime: tag(text, 'LocalScanTime'), count, battery, runtime, history };
}

// ---- running it ----

const ps = async (script, timeout) => {
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.replace(/^﻿/, '').trim() || 'null');
};

// powercfg writes the report to a file: one in the temp folder with a random name, always removed again.
async function runPowercfg() {
  const file = path.join(os.tmpdir(), `webase-battery-${crypto.randomBytes(6).toString('hex')}.xml`);
  try {
    await execFile('powercfg.exe', ['/batteryreport', '/xml', '/output', file], { timeout: 30000, windowsHide: true });
    const st = await fs.stat(file);
    if (st.size > 4 * 1024 * 1024) throw new Error('The battery report was far bigger than expected.');
    return await fs.readFile(file, 'utf8');
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

const defaults = () => ({ nowRaw: () => ps(NOW_SCRIPT, 30000), runReport: runPowercfg });

let design = { designMwh: null, relative: false }; // from the last report; the design capacity does not change, so it is kept
let designTried = false;
let inFlight = null; // one report at a time

// The history and health from Windows' report. A PC without a battery gives { present: false }, never an error.
async function batteryReport(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let xml;
    try {
      xml = await d.runReport();
    } catch (e) {
      const raw = await d.nowRaw().catch(() => null);
      if (raw && raw.present === false) return { present: false }; // no battery: powercfg refuses
      throw new Error('Windows could not make the battery report. Try again.');
    }
    const r = parseReport(xml);
    if (!r) return { present: false };
    designTried = true;
    design = { designMwh: r.battery.designMwh, relative: r.battery.relative };
    const keep = !r.battery.relative;
    return {
      present: true,
      count: r.count,
      scanTime: r.scanTime,
      relative: r.battery.relative,
      battery: { manufacturer: r.battery.manufacturer, chemistry: r.battery.chemistry, designMwh: keep ? r.battery.designMwh : null, fullMwh: keep ? r.battery.fullMwh : null, cycles: r.battery.cycles, health: r.battery.health },
      runtime: r.runtime,
      history: r.history.map((h) => (keep ? h : { ...h, designMwh: null, fullMwh: null })),
    };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// What the battery is doing now. The design capacity comes from the report, read once (the first call) and kept.
async function getBattery(overrides = {}) {
  const d = { ...defaults(), ...overrides };
  const raw = await d.nowRaw();
  if (!raw || raw.present !== true) return { present: false };
  if (design.designMwh === null && !designTried) {
    designTried = true;
    await batteryReport(overrides).catch(() => {}); // health needs the design capacity; without the report it stays unknown
  }
  return readNow(raw, design);
}

module.exports = { getBattery, batteryReport, readNow, parseReport, isoMinutes, healthPct, NOW_SCRIPT, _reset: () => { design = { designMwh: null, relative: false }; designTried = false; inFlight = null; } };
