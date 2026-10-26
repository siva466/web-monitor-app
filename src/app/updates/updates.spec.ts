import { TestBed } from '@angular/core/testing';
import { AppUpdate } from '../api';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';
import { Updates } from './updates';

const up = (name: string, id: string, over: Partial<AppUpdate> = {}): AppUpdate => ({ name, id, version: '1.0', available: '2.0', source: 'winget', explicit: false, ...over });
const rows = (): AppUpdate[] => [
  up('7-Zip', '7zip.7zip'),
  up('Git', 'Git.Git', { version: '2.50', available: '2.51' }),
  up('Pinned', 'Some.Pinned', { explicit: true }),
  up('Store App', 'Some.Store', { source: 'msstore' }),
  up('App Installer', 'Microsoft.AppInstaller'),
];

function setup(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fake = {
    appUpdates: async () => rows(),
    upgradeApp: async (id: string) => { calls.push(id); return { id, name: id, from: '1.0', to: '2.0', expected: '2.0', updated: true, exitCode: 0, message: null }; },
    ...over,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Updates], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(Updates);
  return { fixture, el: fixture.nativeElement as HTMLElement, ui: TestBed.inject(UiService), calls };
}

const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
};
const box = (el: HTMLElement, name: string) => el.querySelector(`input[aria-label="Choose ${name}"]`) as HTMLInputElement | null;
const button = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement;

describe('Updates: update several apps', () => {
  it('only plain winget updates can be ticked: held back, other sources and winget itself cannot; nothing is ticked at first', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    expect(box(el, '7-Zip')).toBeTruthy();
    expect(box(el, 'Git')).toBeTruthy();
    for (const n of ['Pinned', 'Store App', 'App Installer']) expect(box(el, n)).toBeNull();
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
    expect(button(el, 'Update selected').disabled).toBe(true);
    expect(el.textContent).toContain('Tick the updates you want');
  });

  it('Select all ticks the updatable ones, Clear unticks them', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    button(el, 'Select all').click();
    await flush(fixture);
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(2);
    expect(el.textContent).toContain('2 of 2 ticked');
    button(el, 'Clear').click();
    await flush(fixture);
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
  });

  it('the dialog lists every ticked app with from and to versions; declining updates nothing', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    button(el, 'Select all').click();
    await flush(fixture);
    button(el, 'Update selected').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Update 2 apps?');
    expect(ui.dialog()?.items).toEqual(['7-Zip: 1.0 to 2.0', 'Git: 2.50 to 2.51']);
    expect(ui.dialog()?.body).toContain('one after another');
    ui.answer(false);
    await flush(fixture);
    expect(calls).toEqual([]);
  });

  it('confirming updates them one at a time, reports each, and checks again', async () => {
    let n = 0;
    const { fixture, el, ui, calls } = setup({
      appUpdates: async () => (n++ === 0 ? rows() : rows().slice(2)),
      upgradeApp: async (id: string) => { calls.push(id); return id === 'Git.Git' ? { id, name: id, from: '1', to: '1', expected: '2', updated: false, exitCode: 1, message: 'The installer reported a fatal error.' } : { id, name: id, from: '1', to: '2', expected: '2', updated: true, exitCode: 0, message: null }; },
    });
    await flush(fixture);
    button(el, 'Select all').click();
    await flush(fixture);
    button(el, 'Update selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['7zip.7zip', 'Git.Git']);
    expect(ui.toasts().at(-1)?.text).toBe('1 of 2 updated. 1 did not update.');
    expect(el.textContent).toContain('The installer reported a fatal error.');
    expect(el.textContent).toContain('now 2');
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
  });

  it('Stop ends the run after the app that is running, and says how many were not started', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const { fixture, el, ui, calls } = setup({
      upgradeApp: async (id: string) => { calls.push(id); await first; return { id, name: id, from: '1', to: '2', expected: '2', updated: true, exitCode: 0, message: null }; },
    });
    await flush(fixture);
    button(el, 'Select all').click();
    await flush(fixture);
    button(el, 'Update selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    expect(el.textContent).toContain('Updating 1 of 2');
    button(el, 'Stop after this one').click();
    release();
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['7zip.7zip']);
    expect(ui.toasts().at(-1)?.text).toBe('1 of 2 updated. Stopped: 1 not started.');
  });

  it('leaving the page stops a run: nothing new is started after it', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const { fixture, el, ui, calls } = setup({
      upgradeApp: async (id: string) => { calls.push(id); await first; return { id, name: id, from: '1', to: '2', expected: '2', updated: true, exitCode: 0, message: null }; },
    });
    await flush(fixture);
    button(el, 'Select all').click();
    await flush(fixture);
    button(el, 'Update selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    fixture.destroy();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['7zip.7zip']);
  });
});
