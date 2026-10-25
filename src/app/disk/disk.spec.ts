import { TestBed } from '@angular/core/testing';
import { BinList, CacheGroup, DiskListing, LargeScan } from '../api';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';
import { DiskSpace } from './disk';

const row = (name: string, kind: 'folder' | 'file' | 'link', bytes: number, id: string | null, over: object = {}) => ({ id, name, kind, bytes, files: kind === 'folder' ? 3 : 1, share: 0, denied: 0, partial: false, note: null, ...over });
const listing = (over: Partial<DiskListing> = {}): DiskListing => ({
  id: '1', path: 'C:\\', trail: [{ id: '1', label: 'Drive C:' }], total: 1000, rest: { count: 4, bytes: 30 }, links: 1, denied: 2, partial: false,
  drive: { letter: 'C', used: 1500, size: 4000 }, notCounted: 500, tookMs: 5,
  rows: [row('Users', 'folder', 600, '2', { share: 0.6, note: null }), row('pagefile.sys', 'file', 300, '3', { share: 0.3, note: 'Size taken from the directory; the file is in use or protected.' }), row('portal', 'link', 0, null)],
  ...over,
});
const large = (): LargeScan => ({
  files: [
    { id: '1', name: 'movie.mkv', folder: 'Films', bytes: 3e9, modifiedMs: Date.now() - 90 * 86400000, ageDays: 90, whyNot: null },
    { id: '2', name: 'setup.exe', folder: '', bytes: 2e8, modifiedMs: Date.now() - 2 * 86400000, ageDays: 2, whyNot: null },
    { id: '3', name: 'disk.iso', folder: '', bytes: 1e8, modifiedMs: Date.now(), ageDays: 0, whyNot: null },
  ],
  matching: 5, matchingBytes: 4e9, scanned: { files: 40, bytes: 5e9, denied: 0 },
});
const bin = (items = 3): BinList => ({
  totals: { items, bytes: items ? 700 : 0 }, hidden: items ? 1 : 0,
  drives: items ? [{ drive: 'C', items: 2, bytes: 600 }, { drive: 'D', items: 1, bytes: 100 }] : [],
  shown: items ? [{ name: 'a.zip', from: 'C:\\Users\\u\\Downloads', deleted: '2026-10-25T13:00:00.000Z', isFolder: false, drive: 'C', bytes: 500 }, { name: 'b.txt', from: 'C:\\Users\\u\\Desktop', deleted: null, isFolder: false, drive: 'C', bytes: 5 }] : [],
  checkedAt: Date.now(),
});
const BROWSER_COST = 'The browser rebuilds it as you browse, so pages can load a little slower at first.';
const SHADER_COST = 'Games and apps rebuild it as they run, so the first launch of each game can stutter or load slower, and it grows back to about the same size.';
const caches = (): CacheGroup[] => [
  { id: 'brave', name: 'Brave', group: 'Browsers', cost: BROWSER_COST, running: false, note: null, bytes: 2400, partial: false, dirs: [{ label: 'Default\\Cache', bytes: 2000, partial: false }, { label: 'GrShaderCache', bytes: 400, partial: false }] },
  { id: 'edge', name: 'Microsoft Edge', group: 'Browsers', cost: BROWSER_COST, running: true, note: 'Edge often keeps running in the background, so this may stay disabled with no window open. Close it from the taskbar tray or Task Manager.', bytes: 50, partial: false, dirs: [{ label: 'Default\\Cache', bytes: 50, partial: false }] },
  { id: 'nvidia-shader', name: 'NVIDIA shader cache', group: 'Graphics', cost: SHADER_COST, running: false, note: null, bytes: 6 * 1048576, partial: false, dirs: [{ label: 'NVIDIA\\DXCache', bytes: 6 * 1048576, partial: false }] },
  { id: 'npm', name: 'npm cache', group: 'Developer tools', cost: 'npm downloads packages again the next time an install needs them.', running: false, note: null, bytes: 5120, partial: true, dirs: [{ label: 'npm-cache', bytes: 5120, partial: true }] },
  { id: 'steam-web', name: 'Steam web cache', group: 'Apps', cost: 'Steam rebuilds it; store and community pages load again from the internet.', running: true, note: null, bytes: 0, partial: false, dirs: [{ label: 'Steam\\htmlcache', bytes: 0, partial: false }] },
];

function setup(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fake = {
    diskDrives: async () => [{ letter: 'C', used: 1500, size: 4000, free: 2500 }],
    diskStarts: async () => [{ key: 'profile', label: 'Your user folder' }, { key: 'pf', label: 'Program Files' }, { key: 'drive:C', label: 'Drive C:' }],
    scanDiskStart: async (k: string) => { calls.push(`start ${k}`); return listing(); },
    scanDiskChild: async (id: string) => { calls.push(`child ${id}`); return listing({ id, trail: [{ id: '1', label: 'Drive C:' }, { id, label: 'Users' }], notCounted: null, drive: null, rest: null, links: 0, denied: 0, rows: [row('me', 'folder', 10, '9')] }); },
    cancelDiskScan: async () => { calls.push('cancel'); },
    revealDiskItem: async (id: string) => { calls.push(`reveal ${id}`); },
    scanDownloads: async (mb: number) => { calls.push(`scan ${mb}`); return large(); },
    trashDownloads: async (ids: string[]) => { calls.push(`trash ${ids.join(',')}`); return { results: ids.map((id) => ({ id, name: `f${id}`, bytes: 1, ok: true, already: false, error: null })), moved: ids.length, failed: 0, freedBytes: 3.2e9 }; },
    revealDownload: async (id: string) => { calls.push(`show ${id}`); },
    listRecycleBin: async () => { calls.push('bin'); return bin(); },
    emptyRecycleBin: async () => { calls.push('empty'); return { status: 'emptied', freedBytes: 700, remaining: 0, message: 'Emptied 3 items.' }; },
    scanCaches: async () => { calls.push('caches'); return caches(); },
    clearCaches: async (ids: string[]) => { calls.push(`clear ${ids.join(',')}`); return { results: ids.map((id) => ({ id, ok: true, freedBytes: 2400, skipped: 0 })), freedBytes: 2400, failed: 0 }; },
    ...over,
  };
  TestBed.resetTestingModule(); // a test may set up a second page
  TestBed.configureTestingModule({ imports: [DiskSpace], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(DiskSpace);
  return { fixture, el: fixture.nativeElement as HTMLElement, ui: TestBed.inject(UiService), calls };
}

// (a macrotask tick as well, so chains of awaited calls inside the page have all settled)
const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
};
const btn = (el: HTMLElement, label: string, by: 'text' | 'aria' = 'text') =>
  Array.from(el.querySelectorAll('button')).find((b) => (by === 'aria' ? b.getAttribute('aria-label') ?? '' : b.textContent ?? '').trim().includes(label)) as HTMLButtonElement;
const tab = (el: HTMLElement, label: string) => Array.from(el.querySelectorAll('[role=tab]')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

describe('Disk space: folders', () => {
  it('shows the drives and starting places, and measures nothing until you choose', async () => {
    const { fixture, el, calls } = setup();
    await flush(fixture);
    expect(el.textContent).toContain('Drive C:');
    expect(el.textContent).toContain('1.5 KB used of 3.9 KB');
    expect(btn(el, 'Program Files')).toBeTruthy();
    expect(btn(el, 'Look inside drive C', 'aria')).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('a drive scan lists the rows, says what could not be counted and what was skipped, and a link is not openable', async () => {
    const { fixture, el, calls } = setup();
    await flush(fixture);
    btn(el, 'Look inside drive C', 'aria').click();
    await flush(fixture);
    expect(calls).toEqual(['start drive:C']);
    const text = el.textContent ?? '';
    expect(text).toContain('Users');
    expect(text).toContain('Not counted: 500 B of this drive');
    expect(text).toContain('2 folders could not be opened');
    expect(text).toContain('1 link not followed');
    expect(text).toContain('4 smaller items not listed');
    expect(text).toContain('Size taken from the directory');
    expect(text).toContain('A link: not followed');
    expect(btn(el, 'Open folder Users', 'aria')).toBeTruthy();
    expect(btn(el, 'Open folder pagefile.sys', 'aria')).toBeUndefined();
    expect(btn(el, 'Open folder portal', 'aria')).toBeUndefined();
  });

  it('going into a folder asks for it by id, the breadcrumb leads back, and Show reveals a row by id', async () => {
    const { fixture, el, calls } = setup();
    await flush(fixture);
    btn(el, 'Look inside drive C', 'aria').click();
    await flush(fixture);
    btn(el, 'Open folder Users', 'aria').click();
    await flush(fixture);
    expect(calls.at(-1)).toBe('child 2');
    expect(el.querySelector('.crumbs')?.textContent).toContain('Drive C:');
    expect(el.querySelector('.crumbs strong')?.textContent).toBe('Users');
    btn(el, 'Show me in File Explorer', 'aria').click();
    await flush(fixture);
    expect(calls.at(-1)).toBe('reveal 9');
    (el.querySelector('.crumbs .pick') as HTMLButtonElement).click();
    await flush(fixture);
    expect(calls.at(-1)).toBe('child 1');
  });

  it('Stop asks the scan to stop, and a stopped scan\'s late result cannot overwrite a newer one', async () => {
    let finishFirst!: (l: DiskListing) => void;
    let n = 0;
    const { fixture, el, calls } = setup({
      scanDiskStart: (k: string) => {
        calls.push(`start ${k}`);
        return n++ === 0 ? new Promise<DiskListing>((r) => { finishFirst = r; }) : Promise.resolve(listing({ trail: [{ id: '1', label: 'Program Files' }], rows: [row('Git', 'folder', 5, '7')] }));
      },
    });
    await flush(fixture);
    btn(el, 'Look inside drive C', 'aria').click();
    await flush(fixture);
    expect(el.textContent).toContain('Measuring');
    btn(el, 'Stop').click();
    await flush(fixture);
    expect(calls).toContain('cancel');
    // a new scan starts while the old one is still unresolved
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Program Files')) as HTMLButtonElement | undefined)?.removeAttribute('disabled');
    (fixture.componentInstance as unknown as { begin(k: string): Promise<void> }).begin('pf');
    await flush(fixture);
    expect(el.textContent).toContain('Git');
    finishFirst(listing({ rows: [row('Stale', 'folder', 1, '8')] }));
    await flush(fixture);
    expect(el.textContent).toContain('Git');
    expect(el.textContent).not.toContain('Stale');
  });

  it('a drive that adds up to more than it says is used explains hard links instead of showing a negative "not counted"', async () => {
    const { fixture, el } = setup({ scanDiskStart: async () => listing({ total: 1300, drive: { letter: 'C', used: 1000, size: 4000 }, notCounted: null }) });
    await flush(fixture);
    btn(el, 'Look inside drive C', 'aria').click();
    await flush(fixture);
    expect(el.textContent).toContain('add up to 300 B more than Windows says is used on this drive');
    expect(el.textContent).toContain('hard links');
    expect(el.textContent).not.toContain('Not counted');
  });

  it('says so when the scan was cut short, and shows an error plainly', async () => {
    const { fixture, el } = setup({ scanDiskStart: async () => listing({ partial: true, notCounted: null }) });
    await flush(fixture);
    btn(el, 'Look inside drive C', 'aria').click();
    await flush(fixture);
    expect(el.textContent).toContain('the sizes are a minimum');
    expect(el.textContent).toContain('At least');
    expect(el.textContent).not.toContain('Not counted');

    const bad = setup({ scanDiskStart: async () => { throw new Error("Error invoking remote method 'disk:scanStart': Error: That is not a place this page can look at."); } });
    await flush(bad.fixture);
    btn(bad.el, 'Look inside drive C', 'aria').click();
    await flush(bad.fixture);
    expect(bad.el.querySelector('.alert')?.textContent).toBe('That is not a place this page can look at.');
  });
});

describe('Disk space: large files in Downloads', () => {
  it('scans when opened (100 MB by default) and ticks nothing', async () => {
    const { fixture, el, calls } = setup();
    await flush(fixture);
    tab(el, 'Large files').click();
    await flush(fixture);
    expect(calls).toEqual(['scan 100']);
    expect(el.textContent).toContain('movie.mkv');
    expect(el.textContent).toContain('in Films');
    expect(el.textContent).toContain('Showing the biggest 3 of 5 files');
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
    expect(btn(el, 'Move to Recycle Bin').disabled).toBe(true);
  });

  it('the preview lists exactly the ticked files with the total; declining moves nothing', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    tab(el, 'Large files').click();
    await flush(fixture);
    (el.querySelector('input[aria-label="Choose movie.mkv"]') as HTMLInputElement).click();
    (el.querySelector('input[aria-label="Choose disk.iso"]') as HTMLInputElement).click();
    await flush(fixture);
    expect(el.textContent).toContain('2 files chosen');
    btn(el, 'Move to Recycle Bin').click();
    await flush(fixture);
    const d = ui.dialog();
    expect(d?.title).toBe('Move 2 files (2.9 GB) to the Recycle Bin?');
    expect(d?.items).toEqual(['movie.mkv: 2.8 GB', 'disk.iso: 95.4 MB']);
    expect(d?.danger).toBeFalsy();
    expect(d?.body).toContain('not deleted for good');
    ui.answer(false);
    await flush(fixture);
    expect(calls.filter((c) => c.startsWith('trash'))).toEqual([]);
  });

  it('confirming sends the ids, reports the result and scans again with nothing ticked', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    tab(el, 'Large files').click();
    await flush(fixture);
    (el.querySelector('input[aria-label="Choose setup.exe"]') as HTMLInputElement).click();
    await flush(fixture);
    btn(el, 'Move to Recycle Bin').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['scan 100', 'trash 2', 'scan 100']);
    expect(ui.toasts().at(-1)?.text).toBe('Moved 1 file to the Recycle Bin (3.0 GB).');
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
  });

  it('a file the Recycle Bin would not keep is shown with the reason and its box is disabled, so it can never be in the preview', async () => {
    const reason = 'It is too big to be sure the Recycle Bin can hold it. Remove it yourself in File Explorer.';
    const scan = (): LargeScan => ({ ...large(), files: [{ id: '9', name: 'huge.iso', folder: '', bytes: 3e9, modifiedMs: Date.now(), ageDays: 0, whyNot: reason }, ...large().files] });
    const { fixture, el } = setup({ scanDownloads: async () => scan() });
    await flush(fixture);
    tab(el, 'Large files').click();
    await flush(fixture);
    const box = el.querySelector('input[aria-label="Choose huge.iso"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(el.textContent).toContain(reason);
    expect((el.querySelector('input[aria-label="Choose movie.mkv"]') as HTMLInputElement).disabled).toBe(false);
    box.click(); // even a forced click ticks nothing
    await flush(fixture);
    expect(el.querySelectorAll('input[type=checkbox]:checked').length).toBe(0);
    expect(btn(el, 'Move to Recycle Bin').disabled).toBe(true);
  });

  it('files the app left alone are named with the reason', async () => {
    const { fixture, el, ui } = setup({ trashDownloads: async () => ({ results: [{ id: '1', name: 'movie.mkv', bytes: 3e9, ok: false, already: false, error: 'It has changed since the scan, so it was left alone. Scan again.' }], moved: 0, failed: 1, freedBytes: 0 }) });
    await flush(fixture);
    tab(el, 'Large files').click();
    await flush(fixture);
    (el.querySelector('input[aria-label="Choose movie.mkv"]') as HTMLInputElement).click();
    await flush(fixture);
    btn(el, 'Move to Recycle Bin').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    const t = ui.toasts().at(-1);
    expect(t?.kind).toBe('info');
    expect(t?.text).toContain('1 left alone: movie.mkv: It has changed since the scan');
  });

  it('a long list is cut in the preview with a count of the rest, and changing the size scans again', async () => {
    const many: LargeScan = { ...large(), files: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), name: `f${i}.bin`, folder: '', bytes: 1e8, modifiedMs: Date.now(), ageDays: 0, whyNot: null })) };
    const { fixture, el, ui, calls } = setup({ scanDownloads: async (mb: number) => { calls.push(`scan ${mb}`); return many; } });
    await flush(fixture);
    tab(el, 'Large files').click();
    await flush(fixture);
    for (let i = 0; i < 20; i++) (el.querySelector(`input[aria-label="Choose f${i}.bin"]`) as HTMLInputElement).click();
    await flush(fixture);
    btn(el, 'Move to Recycle Bin').click();
    await flush(fixture);
    expect(ui.dialog()?.items?.length).toBe(16);
    expect(ui.dialog()?.items?.at(-1)).toBe('...and 5 more');
    ui.answer(false);
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = '500';
    select.dispatchEvent(new Event('change'));
    await flush(fixture);
    expect(calls.at(-1)).toBe('scan 500');
  });
});

describe('Disk space: Recycle Bin', () => {
  it('shows the totals per drive and what is hidden', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    tab(el, 'Recycle Bin').click();
    await flush(fixture);
    const text = el.textContent ?? '';
    expect(text).toContain('3 items, 700 B');
    expect(text).toContain('Drive C: 2 items, 600 B');
    expect(text).toContain('Drive D: 1 item, 100 B');
    expect(text).toContain('a.zip');
    expect(text).toContain(new Date('2026-10-25T13:00:00.000Z').toLocaleDateString([], { dateStyle: 'medium' }));
    expect(text).toContain('b.txt');
    expect(text).toContain('1 smaller item not listed');
  });

  it('emptying is a danger dialog that says permanent, all drives and the counts; declining does nothing; confirming empties and looks again', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    tab(el, 'Recycle Bin').click();
    await flush(fixture);
    btn(el, 'Empty Recycle Bin').click();
    await flush(fixture);
    const d = ui.dialog();
    expect(d?.title).toBe('Permanently delete 3 items (700 B)?');
    expect(d?.danger).toBe(true);
    expect(d?.body).toContain('every drive');
    expect(d?.body).toContain('nothing in it can be recovered');
    expect(d?.items).toEqual(['Drive C: 2 items, 600 B', 'Drive D: 1 item, 100 B']);
    ui.answer(false);
    await flush(fixture);
    expect(calls).toEqual(['bin']);
    btn(el, 'Empty Recycle Bin').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['bin', 'empty', 'bin']);
    expect(ui.toasts().at(-1)?.text).toBe('Emptied 3 items. Freed 700 B.');
  });

  it('an empty bin cannot be emptied; a refusal from main (new items arrived) is shown as an error', async () => {
    const empty = setup({ listRecycleBin: async () => bin(0) });
    await flush(empty.fixture);
    tab(empty.el, 'Recycle Bin').click();
    await flush(empty.fixture);
    expect(empty.el.textContent).toContain('Nothing in it');
    expect(btn(empty.el, 'Empty Recycle Bin').disabled).toBe(true);

    const changed = setup({ emptyRecycleBin: async () => { throw new Error('The Recycle Bin has changed since you looked: 1 new item. Refresh and check what is in it before emptying.'); } });
    await flush(changed.fixture);
    tab(changed.el, 'Recycle Bin').click();
    await flush(changed.fixture);
    btn(changed.el, 'Empty Recycle Bin').click();
    await flush(changed.fixture);
    changed.ui.answer(true);
    await flush(changed.fixture);
    await flush(changed.fixture);
    expect(changed.ui.toasts().at(-1)?.kind).toBe('error');
    expect(changed.ui.toasts().at(-1)?.text).toContain('has changed since you looked');
  });
});

describe('Disk space: caches', () => {
  it('groups the caches under headings in a fixed order, with what each one costs; a running program cannot be ticked and says why', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    tab(el, 'Caches').click();
    await flush(fixture);
    expect(Array.from(el.querySelectorAll('h2.panel-title')).map((h) => h.textContent?.trim())).toEqual(['Browsers', 'Graphics', 'Developer tools', 'Apps']);
    expect((el.querySelector('#cache-edge') as HTMLInputElement).disabled).toBe(true);
    expect((el.querySelector('#cache-steam-web') as HTMLInputElement).disabled).toBe(true);
    for (const id of ['brave', 'nvidia-shader', 'npm']) expect((el.querySelector(`#cache-${id}`) as HTMLInputElement).disabled).toBe(false);
    const text = el.textContent ?? '';
    expect(text).toContain('Microsoft Edge is running. Close it');
    expect(text).toContain('Steam web cache is running. Close it');
    expect(text).toContain('Edge often keeps running in the background');
    expect(text).toContain('Default\\Cache: 2.0 KB');
    expect(text).toContain('first launch of each game can stutter');
    expect(text).toContain('npm downloads packages again');
  });

  it('a measurement that was cut short says "at least", in the list and in the dialog', async () => {
    const { fixture, el, ui } = setup();
    await flush(fixture);
    tab(el, 'Caches').click();
    await flush(fixture);
    expect(el.querySelector('#cache-npm')?.closest('section')?.textContent).toContain('at least 5.0 KB');
    (el.querySelector('#cache-npm') as HTMLInputElement).click();
    await flush(fixture);
    btn(el, 'Clear cache').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Clear 1 cache (at least 5.0 KB)?');
    expect(ui.dialog()?.body).not.toContain('Cookies');
    ui.answer(false);
  });

  it('the dialog says what is deleted, names the cost of each, mentions cookies only for a browser, then the chosen ids are sent', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    tab(el, 'Caches').click();
    await flush(fixture);
    (el.querySelector('#cache-brave') as HTMLInputElement).click();
    (el.querySelector('#cache-nvidia-shader') as HTMLInputElement).click();
    await flush(fixture);
    expect(el.textContent).toContain('6.0 MB in 2 caches selected');
    btn(el, 'Clear cache').click();
    await flush(fixture);
    const d = ui.dialog();
    expect(d?.title).toBe('Clear 2 caches (6.0 MB)?');
    expect(d?.danger).toBe(true);
    expect(d?.body).toContain('Cookies, saved passwords, history, bookmarks and extensions are not touched');
    expect(d?.items).toEqual([`Brave: 2.3 KB. ${BROWSER_COST}`, `NVIDIA shader cache: 6.0 MB. ${SHADER_COST}`]);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual(['caches', 'clear brave,nvidia-shader', 'caches']);
    expect(ui.toasts().at(-1)?.text).toBe('Freed 2.3 KB.');
  });

  it('a freed figure built from a cut-short measurement says "at least"', async () => {
    const { fixture, el, ui } = setup({ clearCaches: async () => ({ results: [{ id: 'npm', ok: true, freedBytes: 2000, skipped: 0, partial: true }], freedBytes: 2000, failed: 0 }) });
    await flush(fixture);
    tab(el, 'Caches').click();
    await flush(fixture);
    (el.querySelector('#cache-npm') as HTMLInputElement).click();
    await flush(fixture);
    btn(el, 'Clear cache').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(ui.toasts().at(-1)?.text).toBe('Freed at least 2.0 KB.');
  });

  it('files skipped because they were in use are reported', async () => {
    const { fixture, el, ui } = setup({ clearCaches: async () => ({ results: [{ id: 'brave', ok: true, freedBytes: 2000, skipped: 2 }], freedBytes: 2000, failed: 0 }) });
    await flush(fixture);
    tab(el, 'Caches').click();
    await flush(fixture);
    (el.querySelector('#cache-brave') as HTMLInputElement).click();
    await flush(fixture);
    btn(el, 'Clear cache').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(ui.toasts().at(-1)?.text).toBe('Freed 2.0 KB. 2 files in use were skipped.');
  });
});
