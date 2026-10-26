import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CatalogApp, CatalogList } from '../api';
import { avatarHue, errorText } from '../format';
import { Icon } from '../icon';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

interface Outcome {
  id: string;
  name: string;
  ok: boolean;
  message: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

@Component({
  imports: [Icon],
  selector: 'app-catalog',
  templateUrl: './catalog.html',
  styleUrl: './catalog.scss',
})
export class AppCatalog implements OnInit {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly hue = avatarHue;
  protected readonly data = signal<CatalogList | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly running = signal<{ index: number; total: number; name: string } | null>(null);
  protected readonly outcomes = signal<Outcome[] | null>(null);
  private stopAsked = false;

  constructor() {
    // Leaving the page must not leave a batch running with no progress and no Stop button: nothing new is started after this.
    inject(DestroyRef).onDestroy(() => (this.stopAsked = true));
  }

  private readonly all = computed(() => (this.data()?.categories ?? []).flatMap((c) => c.apps));
  // Any app can be ticked (installed ones too, so a list of what is on this PC can be saved); only the missing ones are installed.
  protected readonly chosen = computed(() => this.all().filter((a) => this.picked().has(a.id)));
  protected readonly toInstall = computed(() => this.chosen().filter((a) => a.state === 'missing'));
  protected readonly view = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return (this.data()?.categories ?? [])
      .map((c) => ({ name: c.name, apps: c.apps.filter((a) => !q || `${a.name} ${a.note} ${a.id} ${c.name}`.toLowerCase().includes(q)) }))
      .filter((c) => c.apps.length);
  });
  protected readonly failedAny = computed(() => (this.outcomes() ?? []).some((o) => !o.ok));
  protected readonly counts = computed(() => ({
    installed: this.all().filter((a) => a.state !== 'missing').length,
    total: this.all().length,
  }));

  ngOnInit() {
    this.load();
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.data.set(await this.sys.catalog());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    }
    const known = new Set(this.all().map((a) => a.id));
    this.picked.update((s) => new Set([...s].filter((id) => known.has(id))));
    this.loading.set(false);
  }

  protected onFilter(e: Event) {
    this.filter.set((e.target as HTMLInputElement).value);
  }

  protected tick(a: CatalogApp) {
    if (this.running()) return;
    this.picked.update((s) => {
      const next = new Set(s);
      if (!next.delete(a.id)) next.add(a.id);
      return next;
    });
  }

  protected stateLabel(a: CatalogApp) {
    return a.state === 'installed' ? 'Installed' : a.state === 'update' ? 'Installed, update available' : '';
  }

  protected stop() {
    this.stopAsked = true;
  }

  protected async install() {
    const chosen = this.toInstall();
    if (!chosen.length) return;
    const skipped = this.chosen().length - chosen.length;
    const ok = await this.ui.confirm({
      title: `Install ${plural(chosen.length, 'app')}?`,
      body: `They download from winget's community catalogue and install one after another, silently. Windows may ask for permission for some of them: stay at the PC and choose Yes. You can stop after the one that is running.${skipped ? ` ${skipped} ticked ${skipped === 1 ? 'app is' : 'apps are'} already installed and will be skipped.` : ''}`,
      items: chosen.map((a) => `${a.name} (${a.id})`),
      confirmLabel: 'Install',
    });
    if (!ok) return;
    this.stopAsked = false;
    this.outcomes.set(null);
    const done: Outcome[] = [];
    for (let i = 0; i < chosen.length; i++) {
      if (this.stopAsked) break;
      const a = chosen[i];
      this.running.set({ index: i + 1, total: chosen.length, name: a.name });
      try {
        const r = await this.sys.installCatalogApp(a.id);
        done.push({ id: a.id, name: a.name, ok: r.installed, message: r.installed ? null : r.message });
      } catch (e) {
        done.push({ id: a.id, name: a.name, ok: false, message: errorText(e) });
      }
    }
    this.running.set(null);
    this.outcomes.set(done);
    const good = done.filter((d) => d.ok).length;
    const left = chosen.length - done.length;
    const parts = [`${good} of ${chosen.length} installed.`];
    if (done.length - good) parts.push(`${done.length - good} did not install.`);
    if (left) parts.push(`Stopped: ${left} not started.`);
    this.ui.toast(parts.join(' '), good === chosen.length ? 'success' : 'info');
    await this.load();
  }

  protected async exportList() {
    try {
      const r = await this.sys.exportAppList(this.chosen().map((a) => a.id));
      if (r.saved) this.ui.toast(`Saved ${plural(r.count ?? 0, 'app')} to ${r.name}.`, 'success');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }

  protected async importList() {
    try {
      const r = await this.sys.importAppList();
      if (r.canceled) return;
      const byId = new Map(this.all().map((a) => [a.id, a]));
      const known = new Set([...(r.known ?? [])].filter((id) => byId.has(id))); // only what this page really lists
      const unknown = (r.unknown ?? 0) + ((r.known ?? []).length - known.size);
      const missing = [...known].filter((id) => byId.get(id)?.state === 'missing').length;
      this.picked.set(known);
      const parts = [`Ticked ${plural(known.size, 'app')}: ${missing} to install.`];
      if (known.size - missing) parts.push(`${known.size - missing} already installed.`);
      if (unknown) parts.push(`${unknown} not in this catalog, ignored.`);
      this.ui.toast(parts.join(' '), missing ? 'success' : 'info');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }
}
