import { TestBed } from '@angular/core/testing';
import { DriverInstallResult, UpdateScan } from '../api';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';
import { Drivers } from './drivers';

const ID = '3f2a1c9e-8b7d-4e6f-a1b2-c3d4e5f60718';

// A stand-in for the real bridge: Windows Update has no pending driver on the development PC, so the Install button
// can only be exercised here.
function setup(result: Partial<DriverInstallResult> = {}) {
  const calls: string[] = [];
  let release: (r: DriverInstallResult) => void = () => undefined;
  const scan: UpdateScan = {
    checkedAt: Date.now(),
    updates: [
      { id: ID, revision: 201, title: 'Realtek - Audio - 6.0.9', manufacturer: 'Realtek', model: null, cls: 'MEDIA', date: '2026-06-01', sizeBytes: 5_000_000, downloaded: false },
      { id: null, revision: null, title: 'An update without an id', manufacturer: null, model: null, cls: null, date: null, sizeBytes: null, downloaded: false },
    ],
  };
  const fake = {
    drivers: async () => ({ drivers: [], problems: [] }),
    scanDriverUpdates: async () => scan,
    installDriverUpdate: (id: string) => {
      calls.push(id);
      return new Promise<DriverInstallResult>((resolve) => {
        release = (r) => resolve(r);
      });
    },
  };
  TestBed.configureTestingModule({ imports: [Drivers], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(Drivers);
  const el = fixture.nativeElement as HTMLElement;
  const ui = TestBed.inject(UiService);
  const finish = (extra: Partial<DriverInstallResult> = {}) =>
    release({ id: ID, status: 'installed', message: 'The driver was installed.', rebootRequired: false, restorePoint: null, stillOffered: false, ...result, ...extra });
  return { fixture, el, ui, calls, finish };
}

const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('Drivers: installing an update', () => {
  it('offers Install only for an update that has an id, and asks before doing anything', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Check Windows Update')) as HTMLButtonElement).click();
    await flush(fixture);

    const installs = Array.from(el.querySelectorAll('button')).filter((b) => b.getAttribute('aria-label')?.startsWith('Install '));
    expect(installs.length).toBe(1);
    expect(installs[0].getAttribute('aria-label')).toBe('Install Realtek - Audio - 6.0.9');

    installs[0].click();
    await flush(fixture);
    const d = ui.dialog();
    expect(d?.title).toBe('Install this driver?');
    expect(d?.body).toContain('Realtek - Audio - 6.0.9');
    expect(d?.body).toContain('System Restore point');
    expect(d?.body).toContain('installs nothing if that fails');
    expect(calls).toEqual([]); // nothing runs before the answer

    ui.answer(false);
    await flush(fixture);
    expect(calls).toEqual([]);
  });

  it('after a Yes it installs that update once, locks the buttons meanwhile, and reports a restart', async () => {
    const { fixture, el, ui, calls, finish } = setup({ rebootRequired: true });
    await flush(fixture);
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Check Windows Update')) as HTMLButtonElement).click();
    await flush(fixture);
    (el.querySelector('button[aria-label^="Install "]') as HTMLButtonElement).click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);

    expect(calls).toEqual([ID]);
    const busy = el.querySelector('button[aria-label^="Install "]') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toContain('Installing');

    finish();
    await flush(fixture);
    await flush(fixture);
    const text = ui.toasts().map((t) => t.text).join(' | ');
    expect(text).toContain('The driver was installed.');
    expect(text).toContain('Restart Windows');
    expect(calls).toEqual([ID]); // not run again by the rescan
  });

  it('a declined permission prompt is an info message, not an error', async () => {
    const { fixture, el, ui, finish } = setup();
    await flush(fixture);
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Check Windows Update')) as HTMLButtonElement).click();
    await flush(fixture);
    (el.querySelector('button[aria-label^="Install "]') as HTMLButtonElement).click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    finish({ status: 'declined', message: 'The Windows permission prompt was declined, so nothing changed.' });
    await flush(fixture);
    await flush(fixture);
    const last = ui.toasts().at(-1);
    expect(last?.text).toContain('declined');
    expect(last?.kind).toBe('info');
  });
});
