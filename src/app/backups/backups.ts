import { Component, OnInit, inject, signal } from '@angular/core';
import { BackupItem, BackupRow } from '../api';
import { errorText } from '../format';
import { Icon } from '../icon';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

@Component({
  imports: [Icon],
  selector: 'app-backups',
  templateUrl: './backups.html',
})
export class Backups implements OnInit {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly rows = signal<BackupRow[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly open = signal<ReadonlySet<string>>(new Set()); // backups whose items are shown
  protected readonly busy = signal<string | null>(null); // "<backup id>:<item>" or "<backup id>" while something runs

  ngOnInit() {
    this.load();
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.rows.set((await this.sys.listBackups()).backups);
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    }
    this.loading.set(false);
  }

  protected summary(r: BackupRow) {
    if (!r.readable) return 'The list of what was removed is missing or damaged, so nothing can be restored from here.';
    const keys = r.items.filter((i) => i.kind === 'registry').length;
    const folders = r.items.filter((i) => i.kind === 'folder' && i.how === 'recycle-bin').length;
    const files = r.items.filter((i) => i.kind === 'file').length;
    const empty = r.items.filter((i) => i.how === 'admin-empty-folder').length;
    const parts = [
      keys ? `${keys} registry key${keys === 1 ? '' : 's'} saved` : '',
      folders ? `${folders} folder${folders === 1 ? '' : 's'} moved to the Recycle Bin` : '',
      files ? `${files} file${files === 1 ? '' : 's'} moved to the Recycle Bin` : '',
      empty ? `${empty} empty folder${empty === 1 ? '' : 's'} (nothing to restore)` : '',
    ].filter(Boolean);
    return parts.join(', ') || 'Nothing was removed.';
  }

  protected whenOf(r: BackupRow) {
    const t = r.when ? Date.parse(r.when) : NaN;
    return Number.isNaN(t) ? r.id.slice(0, 19).replace('T', ' ') : new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected toggle(id: string) {
    this.open.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected kindLabel(i: BackupItem) {
    return i.kind === 'registry' ? 'Registry' : i.kind === 'file' ? 'File' : i.how === 'recycle-bin' ? 'Folder' : 'Empty folder';
  }

  protected async restore(r: BackupRow, i: BackupItem) {
    const key = i.kind === 'registry';
    const allUsers = key && /^HKEY_LOCAL_MACHINE\\/i.test(i.path);
    const ok = await this.ui.confirm({
      title: key ? 'Restore this registry key?' : i.kind === 'file' ? 'Put this file back?' : 'Put this folder back?',
      body: key
        ? `The saved values are written back.${i.state.startsWith('The key exists') ? ' The key exists now, so values with the same name are overwritten.' : ''}${allUsers ? ' It is in an all-users part of the registry: Windows will ask for permission once.' : ''}`
        : 'It is moved out of the Recycle Bin to the place it was removed from.',
      items: [i.path],
      confirmLabel: key ? 'Restore' : 'Put back',
    });
    if (!ok) return; // (the same restore call serves folders and files: both went to the Recycle Bin)
    this.busy.set(`${r.id}:${i.index}`);
    if (allUsers) this.ui.toast('If Windows asks for permission, choose Yes. No prompt in sight? Look for a flashing shield in the taskbar.', 'info');
    try {
      const res = key ? await this.sys.restoreBackupKey(r.id, i.index) : await this.sys.restoreBackupFolder(r.id, i.index);
      this.ui.toast(res.message, res.status === 'restored' ? 'success' : res.status === 'declined' || res.status === 'not-answered' ? 'info' : 'error');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.busy.set(null);
    await this.load();
  }

  protected async remove(r: BackupRow) {
    const ok = await this.ui.confirm({
      title: 'Delete this backup?',
      body: 'The saved .reg files and the list of what was removed are deleted, so these keys can no longer be restored from here. Folders in the Recycle Bin are not touched.',
      items: [`${r.app ?? r.id}, ${this.whenOf(r)}`],
      confirmLabel: 'Delete backup',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(r.id);
    try {
      await this.sys.deleteBackup(r.id);
      this.ui.toast('Backup deleted.', 'success');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.busy.set(null);
    await this.load();
  }

  protected async openFolder(r: BackupRow) {
    try {
      const problem = await this.sys.openBackup(r.id);
      if (problem) this.ui.toast(problem, 'error');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }
}
