import { TestBed } from '@angular/core/testing';
import { BackupList } from '../api';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';
import { Backups } from './backups';

const ID = '2026-10-25T13-17-12-PuTTY';

const list = (): BackupList => ({
  checkedAt: Date.now(),
  backups: [
    {
      id: ID, when: '2026-10-25T13:17:12.000Z', app: 'PuTTY', publisher: 'Simon Tatham', readable: true,
      items: [
        { index: 0, kind: 'registry', path: 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY', how: 'reg-export', canRestore: true, why: null, state: 'The key exists now (3 values, 1 subkey). Restoring overwrites values with the same name.' },
        { index: 1, kind: 'registry', path: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\SimonTatham\\PuTTY64', how: 'reg-export', canRestore: true, why: null, state: 'The key is gone.' },
        { index: 2, kind: 'folder', path: 'C:\\Users\\u\\AppData\\Roaming\\PuTTY', how: 'recycle-bin', canRestore: true, why: null, state: 'In the Recycle Bin.' },
        { index: 3, kind: 'folder', path: 'C:\\Program Files\\PuTTY', how: 'admin-empty-folder', canRestore: false, why: 'It was an empty folder, so it held nothing to restore.', state: 'Held nothing.' },
        { index: 4, kind: 'registry', path: 'HKEY_CURRENT_USER\\Software\\Odd', how: 'reg-export', canRestore: false, why: 'The file would delete a key (line 5).', state: 'The key is gone.' },
      ],
    },
    { id: '2026-10-20T08-00-00-Broken', when: null, app: null, publisher: null, readable: false, items: [] },
  ],
});

function setup() {
  const calls: string[] = [];
  const fake = {
    listBackups: async () => list(),
    restoreBackupKey: async (id: string, i: number) => { calls.push(`key ${id} ${i}`); return { status: 'restored', message: 'Restored 1 key and 2 values.' }; },
    restoreBackupFolder: async (id: string, i: number) => { calls.push(`folder ${id} ${i}`); return { status: 'restored', message: 'The folder is back where it was.' }; },
    deleteBackup: async (id: string) => { calls.push(`delete ${id}`); return { deleted: true }; },
    openBackup: async (id: string) => { calls.push(`open ${id}`); return ''; },
  };
  TestBed.configureTestingModule({ imports: [Backups], providers: [{ provide: SystemService, useValue: fake }] });
  const fixture = TestBed.createComponent(Backups);
  return { fixture, el: fixture.nativeElement as HTMLElement, ui: TestBed.inject(UiService), calls };
}

const flush = async (fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) => {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
};
const byLabel = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.getAttribute('aria-label')?.includes(text)) as HTMLButtonElement;

describe('Backups: files', () => {
  it('a removal that moved only a file says so, lists the file, and words the dialog for a file', async () => {
    const only = (): BackupList => ({ checkedAt: Date.now(), backups: [{ id: ID, when: '2026-10-25T13:17:12.000Z', app: 'Notes', publisher: null, readable: true, items: [{ index: 0, kind: 'file', path: 'C:\\Users\\u\\AppData\\Roaming\\note.ini', how: 'recycle-bin', canRestore: true, why: null, state: 'In the Recycle Bin.' }] }] });
    const calls: string[] = [];
    TestBed.configureTestingModule({ imports: [Backups], providers: [{ provide: SystemService, useValue: { listBackups: async () => only(), restoreBackupFolder: async (id: string, i: number) => { calls.push(`${id} ${i}`); return { status: 'restored', message: 'The file is back where it was.' }; } } }] });
    const fixture = TestBed.createComponent(Backups);
    const el = fixture.nativeElement as HTMLElement;
    const ui = TestBed.inject(UiService);
    await flush(fixture);
    expect(el.textContent).toContain('1 file moved to the Recycle Bin');
    expect(el.textContent).not.toContain('Nothing was removed');
    byLabel(el, 'Show what was removed for Notes').click();
    await flush(fixture);
    expect(el.textContent).toContain('File');
    byLabel(el, 'Put back C:').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Put this file back?');
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual([`${ID} 0`]);
  });
});

describe('Backups', () => {
  it('lists each removal with a plain summary, and says when the list of what was removed is damaged', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    const text = el.textContent ?? '';
    expect(text).toContain('PuTTY');
    expect(text).toContain('3 registry keys saved, 1 folder moved to the Recycle Bin, 1 empty folder (nothing to restore)');
    expect(text).toContain('missing or damaged, so nothing can be restored from here');
    expect(el.querySelectorAll('table').length).toBe(0); // collapsed until opened
  });

  it('shows the items when opened, with Restore only where it is possible and the reason where it is not', async () => {
    const { fixture, el } = setup();
    await flush(fixture);
    byLabel(el, 'Show what was removed for PuTTY').click();
    await flush(fixture);
    const restores = Array.from(el.querySelectorAll('button')).filter((b) => /^(Restore|Put back) /.test(b.getAttribute('aria-label') ?? ''));
    expect(restores.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Restore HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY',
      'Restore HKEY_LOCAL_MACHINE\\SOFTWARE\\SimonTatham\\PuTTY64',
      'Put back C:\\Users\\u\\AppData\\Roaming\\PuTTY',
    ]);
    expect(el.textContent).toContain('The file would delete a key (line 5).');
    expect(el.textContent).toContain('It was an empty folder, so it held nothing to restore.');
  });

  it('asks first, says what will happen, and calls the right restore with the backup id and the item number', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    byLabel(el, 'Show what was removed for PuTTY').click();
    await flush(fixture);

    byLabel(el, 'Restore HKEY_CURRENT_USER').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Restore this registry key?');
    expect(ui.dialog()?.body).toContain('values with the same name are overwritten');
    expect(ui.dialog()?.body).not.toContain('permission');
    expect(calls).toEqual([]);
    ui.answer(false);
    await flush(fixture);
    expect(calls).toEqual([]);

    byLabel(el, 'Restore HKEY_LOCAL_MACHINE').click();
    await flush(fixture);
    expect(ui.dialog()?.body).toContain('Windows will ask for permission once');
    expect(ui.dialog()?.body).not.toContain('overwritten');
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual([`key ${ID} 1`]);
    expect(ui.toasts().some((t) => t.text.includes('Restored 1 key') && t.kind === 'success')).toBe(true);

    byLabel(el, 'Put back C:').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Put this folder back?');
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual([`key ${ID} 1`, `folder ${ID} 2`]);
  });

  it('deleting a backup is a danger confirm that says what stays, and calls delete with the id only after Yes', async () => {
    const { fixture, el, ui, calls } = setup();
    await flush(fixture);
    byLabel(el, 'Delete the backup of PuTTY').click();
    await flush(fixture);
    expect(ui.dialog()?.title).toBe('Delete this backup?');
    expect(ui.dialog()?.danger).toBe(true);
    expect(ui.dialog()?.body).toContain('Folders in the Recycle Bin are not touched');
    expect(calls).toEqual([]);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    expect(calls).toEqual([`delete ${ID}`]);
  });

  it('a declined permission prompt is an info message, not an error', async () => {
    const { fixture, el, ui } = setup();
    TestBed.inject(SystemService).restoreBackupKey = async () => ({ status: 'declined', message: 'The Windows permission prompt was declined, so nothing changed.' });
    await flush(fixture);
    byLabel(el, 'Show what was removed for PuTTY').click();
    await flush(fixture);
    byLabel(el, 'Restore HKEY_LOCAL_MACHINE').click();
    await flush(fixture);
    ui.answer(true);
    await flush(fixture);
    await flush(fixture);
    const t = ui.toasts().find((x) => x.text.includes('declined'));
    expect(t?.kind).toBe('info');
  });
});
