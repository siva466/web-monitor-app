import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { InstalledApp, LeftoverItem, LeftoverScan, RemoveResult } from '../api';
import { avatarHue, compareValues, errorText, formatBytes } from '../format';
import { Icon } from '../icon';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

type SortKey = 'name' | 'version' | 'publisher' | 'sizeBytes' | 'installDate';

// Where a leftover scan came from: an app uninstalled just now, or a name typed in for a program removed earlier.
type Source = { mode: 'uninstalled'; key: string; title: string } | { mode: 'manual'; title: string };

@Component({
  imports: [Icon],
  selector: 'app-software',
  templateUrl: './software.html',
})
export class Software implements OnInit {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly fmt = formatBytes;
  protected readonly hue = avatarHue;
  protected readonly columns: { key: SortKey; label: string; num?: boolean }[] = [
    { key: 'name', label: 'Name' },
    { key: 'version', label: 'Version' },
    { key: 'publisher', label: 'Publisher' },
    { key: 'sizeBytes', label: 'Size', num: true },
    { key: 'installDate', label: 'Installed' },
  ];

  protected readonly apps = signal<InstalledApp[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly sortDir = signal<1 | -1>(1);

  protected readonly busyKey = signal<string | null>(null); // the app being uninstalled right now
  protected readonly source = signal<Source | null>(null);
  protected readonly manualName = signal('');
  protected readonly manualPublisher = signal('');
  protected readonly leftovers = signal<LeftoverScan | null>(null);
  protected readonly scanning = signal(false);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly removing = signal(false);
  protected readonly lastRemoval = signal<RemoveResult | null>(null);

  protected readonly pickedItems = computed(() => (this.leftovers()?.items ?? []).filter((i) => this.picked().has(i.id)));
  protected readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    const k = this.sortKey();
    const dir = this.sortDir();
    return this.apps()
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.publisher?.toLowerCase().includes(q))
      .sort((a, b) => compareValues(a[k], b[k], dir));
  });

  ngOnInit() {
    this.load();
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.apps.set(await this.sys.software());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    }
    this.loading.set(false);
  }

  protected sort(key: SortKey) {
    if (this.sortKey() === key) this.sortDir.update((d) => (d === 1 ? -1 : 1));
    else {
      this.sortKey.set(key);
      this.sortDir.set(1);
    }
  }

  protected ariaSort(key: SortKey) {
    return this.sortKey() === key ? (this.sortDir() === 1 ? 'ascending' : 'descending') : 'none';
  }

  protected onSearch(e: Event) {
    this.query.set((e.target as HTMLInputElement).value);
  }

  protected async openFolder(a: InstalledApp) {
    try {
      const problem = await this.sys.openAppFolder(a.key);
      if (problem) this.ui.toast(problem, 'error');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }

  protected async uninstall(a: InstalledApp) {
    const ok = await this.ui.confirm({
      title: `Uninstall ${a.name}?`,
      body: `The app's own uninstaller will run.${a.scope === 'machine' ? ' Windows will ask for permission first.' : ''} Some uninstallers open their own window; finish it there. Settings and files it leaves behind are not removed; you can scan for them afterwards.`,
      confirmLabel: 'Uninstall',
      danger: true,
    });
    if (!ok) return;
    this.busyKey.set(a.key);
    this.closePanel();
    this.ui.toast(`Uninstalling ${a.name}. If Windows asks for permission, choose Yes. If the uninstaller opens its own window, finish it there. No prompt in sight? Look for a flashing shield in the taskbar.`, 'info');
    try {
      const r = await this.sys.uninstallApp(a.key);
      if (r.removed) {
        this.source.set({ mode: 'uninstalled', key: a.key, title: `${a.name} was uninstalled.` });
        this.ui.toast(r.message ?? `${a.name} was uninstalled.`, 'success');
      } else {
        this.ui.toast(r.message ?? `${a.name} was not uninstalled.`, r.cancelled ? 'info' : 'error');
      }
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.busyKey.set(null);
    await this.load();
  }

  // Leftovers

  protected openManual() {
    this.closePanel();
    this.source.set({ mode: 'manual', title: 'Look for leftovers of a program you already removed' });
  }

  protected closePanel() {
    this.source.set(null);
    this.leftovers.set(null);
    this.picked.set(new Set());
    this.lastRemoval.set(null);
  }

  protected onName(e: Event) {
    this.manualName.set((e.target as HTMLInputElement).value);
  }

  protected onPublisher(e: Event) {
    this.manualPublisher.set((e.target as HTMLInputElement).value);
  }

  protected async scanLeftovers() {
    const s = this.source();
    if (!s) return;
    this.scanning.set(true);
    try {
      this.leftovers.set(s.mode === 'uninstalled' ? await this.sys.scanLeftovers(s.key) : await this.sys.scanLeftoversByName(this.manualName().trim(), this.manualPublisher().trim() || null));
      this.picked.set(new Set()); // nothing is ticked after a scan: you choose what goes
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.scanning.set(false);
  }

  protected canPick(i: LeftoverItem) {
    return i.removable; // decided in the main process: low-confidence non-empty, too big, and non-empty all-users items are not
  }

  protected togglePick(i: LeftoverItem) {
    this.picked.update((s) => {
      const next = new Set(s);
      if (!next.delete(i.id)) next.add(i.id);
      return next;
    });
  }

  protected async removePicked() {
    const items = this.pickedItems();
    const lines = items.slice(0, 8).map((i) => `${i.kind === 'registry' ? 'Registry' : i.kind === 'folder' ? 'Folder' : 'File'}: ${i.path}`);
    if (items.length > 8) lines.push(`...and ${items.length - 8} more`);
    const admin = items.filter((i) => i.allUsers).length;
    const ok = await this.ui.confirm({
      title: `Remove ${items.length} leftover${items.length === 1 ? '' : 's'}?`,
      body:
        'Registry keys are saved to a backup file first, and a key that cannot be backed up is not removed. Files and folders go to the Recycle Bin, so you can put them back (anything over 2 GB is left for you to remove yourself).' +
        (admin ? ` ${admin} of these ${admin === 1 ? 'is' : 'are'} in an all-users place (Program Files, ProgramData or HKLM). Windows will ask for administrator permission once for ${admin === 1 ? 'it' : 'them'}; only empty folders and registry keys are removed there.` : ''),
      items: lines,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.removing.set(true);
    try {
      const r = await this.sys.removeLeftovers(items.map((i) => i.id));
      this.lastRemoval.set(r);
      const firstError = r.results.find((x) => !x.ok)?.error;
      if (r.failed) this.ui.toast(`Removed ${r.removed} of ${r.removed + r.failed}. ${firstError ?? ''}`.trim(), 'error');
      else this.ui.toast(`Removed ${r.removed}. A backup was saved first.`, 'success');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.removing.set(false);
    await this.scanLeftovers(); // show what is left now
  }

  protected async reveal(i: LeftoverItem) {
    try {
      await this.sys.revealLeftover(i.id);
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }

  protected async openBackups() {
    try {
      const problem = await this.sys.openBackupFolder();
      if (problem) this.ui.toast(problem, 'error');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }
}
