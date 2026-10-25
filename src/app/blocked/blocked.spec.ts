import { TestBed } from '@angular/core/testing';
import { BlockedList } from '../api';
import { SystemService } from '../system.service';
import { Blocked } from './blocked';

const list = (over: Partial<BlockedList> = {}): BlockedList => ({
  checkedAt: Date.now(),
  eventCount: 3,
  oldest: '2026-10-18T04:50:00.000Z',
  sac: { state: 'on', label: 'On', text: 'Smart App Control is on: Windows blocks apps it cannot confirm are safe.' },
  rows: [
    {
      file: 'C:\\Windows\\System32\\nvspcap64.dll', fileName: 'nvspcap64.dll', process: 'C:\\Windows\\UUS\\amd64\\WaaSMedicAgent.exe', processName: 'WaaSMedicAgent.exe',
      kind: 'signing-level', count: 8, first: '2026-10-18T04:54:11.000Z', last: '2026-10-25T03:10:11.000Z', needed: 'Microsoft', got: null, policy: null,
      product: 'NVIDIA App', description: 'NVIDIA Game Proxy', company: 'NVIDIA Corporation', version: '11.0.9.565', publisher: 'NVIDIA Corporation', signature: 'valid', exists: true,
      reason: 'WaaSMedicAgent.exe only accepts files signed by Microsoft, and refused nvspcap64.dll. It is signed by NVIDIA Corporation. The file itself may be fine.',
    },
    {
      file: 'D:\\x\\Webase System Monitor.exe', fileName: 'Webase System Monitor.exe', process: 'C:\\Program Files\\nodejs\\node.exe', processName: 'node.exe',
      kind: 'policy', count: 2, first: '2026-10-25T15:04:20.000Z', last: '2026-10-25T15:04:21.000Z', needed: 'Enterprise', got: 'unsigned', policy: 'VerifiedAndReputableDesktop',
      product: 'Webase System Monitor', description: null, company: null, version: null, publisher: null, signature: null, exists: false,
      reason: "Windows' app control blocked Webase System Monitor.exe (policy \"VerifiedAndReputableDesktop\", named like the policy Smart App Control uses).",
    },
  ],
  ...over,
});

function setup(data: BlockedList | (() => Promise<BlockedList>) = list()) {
  const calls: string[] = [];
  const fake = {
    listBlocked: async () => (typeof data === 'function' ? data() : data),
    openDriverLink: async (key: string) => { calls.push(key); },
  };
  TestBed.configureTestingModule({ imports: [Blocked], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(Blocked);
  return { fixture, el: fixture.nativeElement as HTMLElement, calls };
}

const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('Blocked', () => {
  it('shows the Smart App Control state, one row per blocked file, who tried it, why, and how often', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    const text = el.textContent ?? '';
    expect(text).toContain('Smart App Control');
    expect(el.querySelector('.chip-ok')?.textContent?.trim()).toBe('On');
    expect(el.querySelectorAll('tbody tr').length).toBe(2);
    expect(text).toContain('nvspcap64.dll');
    expect(text).toContain('WaaSMedicAgent.exe');
    expect(text).toContain('only accepts files signed by Microsoft, and refused nvspcap64.dll');
    expect(text).toContain('NVIDIA Game Proxy · NVIDIA Corporation · signature valid');
    expect(text).toContain('Refused by the program');
    expect(text).toContain('Blocked by app control');
    expect(text).toContain('The file is not there any more.');
    expect(text).toMatch(/8\s+last /);
  });

  it('says honestly what it knows: how many records, since when, and that it cannot name the notification you saw', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('3 block records.');
    expect(text).toContain("Windows' log goes back to");
    expect(text).toContain('this is all it kept');
    expect(text).toContain('cannot tell which notification you saw');
    expect(text).toContain('never unblocks anything or changes Smart App Control');
  });

  it('an empty log and a Smart App Control that is off are shown plainly', async () => {
    const { fixture, el } = setup(list({ rows: [], eventCount: 0, oldest: null, sac: { state: 'off', label: 'Off', text: 'Smart App Control is off.' } }));
    await flush(fixture);
    expect(el.textContent).toContain('Windows has not recorded any blocked file in this log.');
    expect(el.querySelector('.chip-ok')).toBeNull();
    expect(el.textContent).toContain('0 block records');
  });

  it('opens Windows Security through the fixed link key, never a URL of its own', async () => {
    const { fixture, el, calls } = setup();
    await flush(fixture);
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Open Windows Security')) as HTMLButtonElement).click();
    await flush(fixture);
    expect(calls).toEqual(['app-control']);
  });

  it('a failed read shows the error and no table', async () => {
    const { fixture, el } = setup(() => Promise.reject(new Error('The log could not be read.')));
    await flush(fixture);
    await flush(fixture);
    expect(el.querySelector('.alert-danger')?.textContent).toContain('The log could not be read.');
    expect(el.querySelectorAll('tbody tr').length).toBe(0);
  });
});
