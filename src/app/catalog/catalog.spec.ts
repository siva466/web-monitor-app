import { TestBed } from '@angular/core/testing';
import { CatalogList } from '../api';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';
import { AppCatalog } from './catalog';

const list = (): CatalogList => ({
  checkedAt: Date.now(),
  categories: [
    { name: 'Browsers', apps: [
      { id: 'Mozilla.Firefox', name: 'Firefox', note: 'Open-source browser.', state: 'installed', version: '140', available: null },
      { id: 'Google.Chrome', name: 'Google Chrome', note: "Google's browser.", state: 'missing', version: null, available: null },
    ] },
    { name: 'Media', apps: [
      { id: 'VideoLAN.VLC', name: 'VLC media player', note: 'Plays almost any file.', state: 'missing', version: null, available: null },
      { id: 'OBSProject.OBSStudio', name: 'OBS Studio', note: 'Screen recording.', state: 'update', version: '30', available: '31' },
    ] },
  ],
});
const ok = (id: string) => ({ id, name: id, installed: true, exitCode: 0, message: null });

function setup(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fake = {
    catalog: async () => list(),
    installCatalogApp: async (id: string) => { calls.push(`install ${id}`); return ok(id); },
    exportAppList: async (ids: string[]) => { calls.push(`export ${ids.join(',')}`); return { saved: true, name: 'mine.json', count: ids.length }; },
    importAppList: async () => ({ canceled: true }),
    ...over,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [AppCatalog], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(AppCatalog);
  return { fixture, el: fixture.nativeElement as HTMLElement, ui: TestBed.inject(UiService), calls };
}

const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
};
const box = (el: HTMLElement, id: string) => el.querySelector(`#app-${CSS.escape(id)}`) as HTMLInputElement;
const button = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => {
  const input = el.querySelector('input[type=search]') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('App catalog', () => {
  it('lists the apps by category with what is installed, and nothing is ticked at first', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    expect(Array.from(el.querySelectorAll('h2.panel-title')).map((h) => h.textContent?.trim())).toEqual(['Browsers', 'Media']);
    const text = el.textContent ?? '';
    expect(text).toContain('Firefox');
    expect(text).toContain('Plays almost any file.');
    expect(text).toContain('Mozilla.Firefox');
    expect(Array.from(el.querySelectorAll('.chip')).map((c) => c.textContent?.trim())).toEqual(['Installed', 'Installed, update available']);
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
    expect(button(el, 'Install selected').disabled).toBe(true);
    expect(text).toContain('2 of 4 are already installed');
  });

  it('the filter searches names, notes and ids, and says so when nothing matches', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    type(el, 'vlc');
    await flush(fixture);
    expect(Array.from(el.querySelectorAll('.app-row strong')).map((s) => s.textContent?.trim())).toEqual(['VLC media player']);
    type(el, 'browser');
    await flush(fixture);
    expect(Array.from(el.querySelectorAll('.app-row strong')).map((s) => s.textContent?.trim())).toEqual(['Firefox', 'Google Chrome']);
    type(el, 'zzzz');
    await flush(fixture);
    expect(el.textContent).toContain('Nothing in the catalog matches that.');
  });

  it('an installed app can be ticked (to save a list) but only the missing ones are installed', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    box(el, 'Mozilla.Firefox').click();
    await flush(fixture);
    expect(el.textContent).toContain('1 app ticked, 0 to install');
    expect(button(el, 'Install selected').disabled).toBe(true);
    expect(button(el, 'Save list...').disabled).toBe(false);
    box(el, 'VideoLAN.VLC').click();
    await flush(fixture);
    expect(el.textContent).toContain('2 apps ticked, 1 to install');
    button(el, 'Install selected').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Install 1 app?');
    expect(ui.dialog()?.items).toEqual(['VLC media player (VideoLAN.VLC)']);
    expect(ui.dialog()?.body).toContain('1 ticked app is already installed and will be skipped');
    expect(ui.dialog()?.body).toContain('Windows may ask for permission');
    ui.answer(false);
    await flush(fixture);
    expect(calls).toEqual([]);
  });

  it('installs the missing ones one at a time, reports each (a failure and an error included), and checks again', async () => {
    let n = 0;
    const { fixture, el, ui, calls } = setup({
      catalog: async () => (n++ === 0 ? list() : { ...list(), categories: [{ name: 'Browsers', apps: list().categories[0].apps.map((a) => (a.id === 'Google.Chrome' ? { ...a, state: 'installed' as const } : a)) }] }),
      installCatalogApp: async (id: string) => {
        calls.push(`install ${id}`);
        if (id === 'VideoLAN.VLC') return { id, name: id, installed: false, exitCode: 1603, message: 'The installer reported a fatal error.' };
        if (id === 'Zzz') throw new Error('x');
        return ok(id);
      },
    });
    await flush(fixture);
    box(el, 'Google.Chrome').click();
    box(el, 'VideoLAN.VLC').click();
    await flush(fixture);
    button(el, 'Install selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['install Google.Chrome', 'install VideoLAN.VLC']);
    expect(ui.toasts().at(-1)?.text).toBe('1 of 2 installed. 1 did not install.');
    const text = el.textContent ?? '';
    expect(text).toContain('Google Chrome: installed');
    expect(text).toContain('VLC media player: not installed');
    expect(text).toContain('The installer reported a fatal error.');
    expect(text).toContain('the Blocked page shows which file and why');
  });

  it('an app that is already installed some other way comes back as an error and the rest continue', async () => {
    const { fixture, el, ui, calls } = setup({
      installCatalogApp: async (id: string) => { calls.push(`install ${id}`); if (id === 'Google.Chrome') throw new Error("Error invoking remote method 'cat:install': Error: Google Chrome is already installed."); return ok(id); },
    });
    await flush(fixture);
    box(el, 'Google.Chrome').click();
    box(el, 'VideoLAN.VLC').click();
    await flush(fixture);
    button(el, 'Install selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['install Google.Chrome', 'install VideoLAN.VLC']);
    expect(el.textContent).toContain('Google Chrome is already installed.');
    expect(el.textContent).not.toContain("Error invoking remote method");
  });

  it('Stop ends the run after the app that is running and says how many were not started', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const { fixture, el, ui, calls } = setup({ installCatalogApp: async (id: string) => { calls.push(`install ${id}`); await first; return ok(id); } });
    await flush(fixture);
    box(el, 'Google.Chrome').click();
    box(el, 'VideoLAN.VLC').click();
    await flush(fixture);
    button(el, 'Install selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    expect(el.textContent).toContain('Installing 1 of 2');
    expect(box(el, 'VideoLAN.VLC').disabled).toBe(true);
    button(el, 'Stop after this one').click();
    release();
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['install Google.Chrome']);
    expect(ui.toasts().at(-1)?.text).toBe('1 of 2 installed. Stopped: 1 not started.');
  });

  it('leaving the page stops the run: nothing new is started after it', async () => {
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const { fixture, el, ui, calls } = setup({ installCatalogApp: async (id: string) => { calls.push(`install ${id}`); await first; return ok(id); } });
    await flush(fixture);
    box(el, 'Google.Chrome').click();
    box(el, 'VideoLAN.VLC').click();
    await flush(fixture);
    button(el, 'Install selected').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    fixture.destroy();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['install Google.Chrome']);
  });

  it('Save list saves everything ticked, installed apps included, and says what was saved; a cancelled dialog says nothing', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    box(el, 'Mozilla.Firefox').click();
    box(el, 'VideoLAN.VLC').click();
    await flush(fixture);
    button(el, 'Save list...').click();
    await flush(fixture);
    expect(calls).toEqual(['export Mozilla.Firefox,VideoLAN.VLC']);
    expect(ui.toasts().at(-1)?.text).toBe('Saved 2 apps to mine.json.');
    const before = ui.toasts().length;
    const cancelled = setup({ exportAppList: async () => ({ saved: false }) });
    await flush(cancelled.fixture);
    box(cancelled.el, 'VideoLAN.VLC').click();
    await flush(cancelled.fixture);
    button(cancelled.el, 'Save list...').click();
    await flush(cancelled.fixture);
    expect(cancelled.ui.toasts().length).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it('Save list is disabled until something is ticked, and a refusal is shown', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    expect(button(el, 'Save list...').disabled).toBe(true);
    const bad = setup({ exportAppList: async () => { throw new Error("Error invoking remote method 'cat:export': Error: Nothing is selected."); } });
    await flush(bad.fixture);
    box(bad.el, 'VideoLAN.VLC').click();
    await flush(bad.fixture);
    button(bad.el, 'Save list...').click();
    await flush(bad.fixture);
    expect(bad.ui.toasts().at(-1)).toEqual({ id: expect.any(Number), text: 'Nothing is selected.', kind: 'error' });
  });

  it('Open list ticks the known apps, counts the ones already installed and the ones not in the catalog, and ignores a cancel', async () => {
    const { fixture, el, ui } = setup({ importAppList: async () => ({ canceled: false, read: 5, known: ['Mozilla.Firefox', 'VideoLAN.VLC', 'Not.InThisPage'], unknown: 2 }) });
    await flush(fixture);
    button(el, 'Open list...').click();
    await flush(fixture);
    // 2 reported unknown by main, plus 1 "known" id this page does not list (it is counted, never ticked)
    expect(ui.toasts().at(-1)?.text).toBe('Ticked 2 apps: 1 to install. 1 already installed. 3 not in this catalog, ignored.');
    expect(box(el, 'VideoLAN.VLC').checked).toBe(true);
    expect(box(el, 'Mozilla.Firefox').checked).toBe(true);
    expect(box(el, 'Google.Chrome').checked).toBe(false);

    const cancelled = setup();
    await flush(cancelled.fixture);
    button(cancelled.el, 'Open list...').click();
    await flush(cancelled.fixture);
    expect(cancelled.ui.toasts().length).toBe(0);
  });

  it('shows an error from winget plainly', async () => {
    const { fixture, el } = setup({ catalog: async () => { throw new Error("Error invoking remote method 'cat:list': Error: winget is not available on this PC."); } });
    await flush(fixture);
    expect(el.querySelector('.alert')?.textContent).toBe('winget is not available on this PC.');
  });
});
