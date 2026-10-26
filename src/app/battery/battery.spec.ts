import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';
import { BatteryNow, BatteryReport } from '../api';
import { SystemService } from '../system.service';
import { Battery } from './battery';

const now = (over: Partial<BatteryNow> = {}): BatteryNow => ({
  present: true, count: 1, percent: 100, state: 'full', acOnline: true, critical: false, minutesLeft: null, estimating: false, relative: false,
  powerW: null, voltageV: 17.27, remainingMwh: 58610, fullMwh: 58610, designMwh: 60000, cycles: 33, health: 97.7, ...over,
});
const row = (from: string, to: string, over: object = {}) => ({ from, to, designMwh: 60000, fullMwh: 58610, health: 97.7, cycles: 32, activeBatteryMin: 0.8, standbyBatteryMin: 0, activeAcMin: 826.7, standbyAcMin: 116.6, ...over });
const report = (over: Partial<BatteryReport> = {}): BatteryReport => ({
  present: true, count: 1, scanTime: '2026-10-26T23:10:36', relative: false,
  battery: { manufacturer: 'BYD', chemistry: 'Lithium polymer', designMwh: 60000, fullMwh: 58610, cycles: 33, health: 97.7 },
  runtime: { fullActiveMin: 97.5, fullStandbyMin: 679.2, designActiveMin: 99.8, designStandbyMin: 695.3 },
  history: [row('2026-10-25T00:00:00', '2026-10-25T23:59:59'), row('2026-10-10T09:01:21', '2026-10-17T09:01:21', { activeAcMin: 3113.3, activeBatteryMin: 0 })],
  ...over,
});

function setup(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fake = {
    battery: async () => { calls.push('now'); return now(); },
    batteryReport: async () => { calls.push('report'); return report(); },
    ...over,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Battery], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(Battery);
  return { fixture, el: fixture.nativeElement as HTMLElement, calls };
}

const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
};
// every piece of text on the page, trimmed and joined with spaces (the template has no whitespace between elements)
const text = (el: HTMLElement) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  }
  return parts.join(' ');
};
// with fake timers a setTimeout-based wait would never end: let the fake clock run the pending work instead
const flushFake = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await vi.advanceTimersByTimeAsync(0);
  await fixture.whenStable();
  fixture.detectChanges();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Battery page', () => {
  it('shows charge, health with both capacities, cycles, the details and the runtime estimate', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    const t = text(el);
    expect(t).toContain('Charge 100% Plugged in, full');
    expect(t).toContain('Health 97.7%');
    expect(t).toContain('Holds 58.6 Wh full, 60.0 Wh when new');
    expect(t).toContain('Charge cycles 33');
    expect(t).toContain('Made by BYD');
    expect(t).toContain('Type Lithium polymer');
    expect(t).toContain('Voltage 17.27 V');
    expect(t).toContain('Power now Not reported');
    expect(t).toContain("Windows' estimate at a full charge");
    expect(t).toContain('Active use about 1 h 38 min, sleeping with the network on about 11 h 19 min');
    expect(t).toContain('not measurements');
    expect(t).toContain('worn below about 80%');
    expect(el.querySelector('.progress-bar')?.getAttribute('style')).toContain('97.7%');
  });

  it('the history lists the periods as the report wrote the dates, with health, cycles and time on battery and on the charger', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    const rows = Array.from(el.querySelectorAll('tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent?.trim()));
    expect(rows).toEqual([
      ['25 Oct', '58.6 Wh', '97.7%', '32', '1 min', '13 h 47 min'],
      ['10 Oct to 17 Oct', '58.6 Wh', '97.7%', '32', '0 min', '2 d 3 h'],
    ]);
  });

  it('on battery it says how long is left, or that it is estimating; charging says how fast', async () => {
    const a = setup({ battery: async () => now({ state: 'discharging', acOnline: false, percent: 64, minutesLeft: 234, powerW: -12, health: 97.7 }) });
    await flush(a.fixture);
    expect(text(a.el)).toContain('On battery, about 3 h 54 min left');
    expect(text(a.el)).toContain('Using 12.0 W');
    const b = setup({ battery: async () => now({ state: 'discharging', acOnline: false, percent: 64, minutesLeft: null, estimating: true }) });
    await flush(b.fixture);
    expect(text(b.el)).toContain('On battery, estimating the time left...');
    const c = setup({ battery: async () => now({ state: 'charging', percent: 40, powerW: 45 }) });
    await flush(c.fixture);
    expect(text(c.el)).toContain('Charging at 45.0 W');
    expect(text(c.el)).not.toContain('conservation');
  });

  it('plugged in but not charging is explained without calling it a fault, and a critical charge is said plainly', async () => {
    const { fixture, el } = setup({ battery: async () => now({ state: 'plugged', percent: 80, critical: true }) });
    await flush(fixture);
    const t = text(el);
    expect(t).toContain('Plugged in, not charging');
    expect(t).toContain("Battery-care settings, such as the laptop maker's conservation mode, can stop charging early.");
    expect(t).toContain('critically low');
    expect(t).not.toMatch(/fault|problem|faulty/i);
  });

  it('a PC without a battery says so, shows nothing else, and does not ask for the report', async () => {
    const { fixture, el, calls } = setup({ battery: async () => ({ present: false }) });
    await flush(fixture);
    expect(text(el)).toContain('No battery was found. This looks like a desktop PC');
    expect(el.querySelector('.stat')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('when the report fails the live numbers still show, with a plain note about the history', async () => {
    const { fixture, el } = setup({ batteryReport: async () => { throw new Error("Error invoking remote method 'bat:report': Error: Windows could not make the battery report. Try again."); } });
    await flush(fixture);
    const t = text(el);
    expect(t).toContain('Charge 100%');
    expect(t).toContain('The history is not available right now: Windows could not make the battery report. Try again.');
    expect(el.querySelector('tbody')).toBeNull();
  });

  it('a battery that reports relative capacities gets the percentage only, with the reason', async () => {
    const { fixture, el } = setup({
      battery: async () => now({ relative: true, fullMwh: null, designMwh: null, remainingMwh: null, powerW: null }),
      batteryReport: async () => report({ relative: true, history: [row('2026-10-25T00:00:00', '2026-10-25T23:59:59', { fullMwh: null, designMwh: null })] }),
    });
    await flush(fixture);
    const t = text(el);
    expect(t).toContain('Health 97.7%');
    expect(t).toContain('Capacity is reported in relative units, so only the percentage is shown');
    expect(t).not.toContain('Wh full');
    expect(Array.from(el.querySelectorAll('tbody tr td'))[1].textContent?.trim()).toBe('-');
  });

  it('missing numbers show as a dash, not as zero or "NaN"', async () => {
    const { fixture, el } = setup({ battery: async () => now({ percent: null, health: null, cycles: null, voltageV: null, fullMwh: null, designMwh: null }) });
    await flush(fixture);
    const t = text(el);
    expect(t).toContain('Charge - ');
    expect(t).toContain('Health - ');
    expect(t).toContain('Charge cycles - ');
    expect(t).toContain('The design capacity was not available');
    expect(t).not.toMatch(/NaN|undefined|null/);
  });

  it('Refresh reads both again, and the live part is read again every 15 seconds until the page is closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fixture, el, calls } = setup();
    await flushFake(fixture);
    expect(calls).toEqual(['now', 'report']);
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Refresh')) as HTMLButtonElement).click();
    await flushFake(fixture);
    expect(calls).toEqual(['now', 'report', 'now', 'report']);
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls.at(-1)).toBe('now');
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls.length).toBe(n + 2);
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls.length).toBe(n + 2);
  });
});
