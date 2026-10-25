import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DriverList, DriverRow, DriverUpdate, UpdateScan } from '../api';
import { compareValues, errorText, formatBytes } from '../format';
import { Icon } from '../icon';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

type SortKey = 'name' | 'provider' | 'version' | 'date';

const VENDORS = [
  { key: 'nvidia', pattern: /nvidia/i, label: "NVIDIA's driver page" },
  { key: 'amd', pattern: /advanced micro|amd|ati technologies/i, label: "AMD's driver page" },
  { key: 'intel', pattern: /intel/i, label: "Intel's driver page" },
];

const HINTS: Record<number, string> = {
  43: 'Windows stopped this device after it reported a problem. For a USB device, try unplugging it, another port or another cable.',
  28: "Windows has no driver for this device. Check Windows Update or the maker's website.",
  22: 'This device was turned off in Device Manager.',
};

@Component({
  imports: [Icon],
  selector: 'app-drivers',
  templateUrl: './drivers.html',
})
export class Drivers implements OnInit {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly fmt = formatBytes;
  protected readonly hints = HINTS;
  protected readonly columns: { key: SortKey; label: string }[] = [
    { key: 'name', label: 'Device' },
    { key: 'provider', label: 'Provider' },
    { key: 'version', label: 'Version' },
    { key: 'date', label: 'Driver date' },
  ];

  protected readonly data = signal<DriverList | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly scan = signal<UpdateScan | null>(null);
  protected readonly checking = signal(false);
  protected readonly installingId = signal<string | null>(null);
  protected readonly scanError = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly showMicrosoft = signal(false);
  protected readonly sortKey = signal<SortKey>('name');
  protected readonly sortDir = signal<1 | -1>(1);

  protected readonly displays = computed(() => this.data()?.drivers.filter((d) => d.cls === 'DISPLAY') ?? []);
  protected readonly thirdPartyCount = computed(() => this.data()?.drivers.filter((d) => !d.microsoft).length ?? 0);
  protected readonly rows = computed(() => {
    const q = this.query().trim().toLowerCase();
    const k = this.sortKey();
    const dir = this.sortDir();
    return (this.data()?.drivers ?? [])
      .filter((d) => (this.showMicrosoft() || !d.microsoft) && (!q || [d.name, d.provider, d.cls].some((t) => t?.toLowerCase().includes(q))))
      .sort((a, b) => compareValues(a[k], b[k], dir));
  });

  ngOnInit() {
    this.load();
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.data.set(await this.sys.drivers());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    }
    this.loading.set(false);
  }

  protected async checkUpdates() {
    this.checking.set(true);
    this.scanError.set(null);
    try {
      this.scan.set(await this.sys.scanDriverUpdates());
    } catch (e) {
      this.scanError.set(errorText(e));
    }
    this.checking.set(false);
  }

  protected async install(u: DriverUpdate) {
    if (!u.id) return;
    const ok = await this.ui.confirm({
      title: 'Install this driver?',
      body: `${u.title}. Windows makes a System Restore point first and installs nothing if that fails, then downloads and installs the driver from Windows Update. It can take several minutes, the screen may flicker, and a restart may be needed. Windows asks for permission once.`,
      confirmLabel: 'Install',
    });
    if (!ok) return;
    this.installingId.set(u.id);
    this.ui.toast(`Installing ${u.title}. If Windows asks for permission, choose Yes. No prompt in sight? Look for a flashing shield in the taskbar.`, 'info');
    try {
      const r = await this.sys.installDriverUpdate(u.id);
      const done = r.status === 'installed' || r.status === 'installed-with-errors';
      const kind = r.status === 'installed' ? 'success' : done || r.status === 'declined' || r.status === 'not-answered' ? 'info' : 'error';
      this.ui.toast(`${r.message}${r.rebootRequired ? ' Restart Windows to finish.' : ''}`, kind);
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.installingId.set(null);
    await this.checkUpdates(); // show what Windows Update offers now
  }

  protected vendorOf(d: DriverRow) {
    return VENDORS.find((v) => v.pattern.test(d.provider ?? '')) ?? null;
  }

  protected async open(key: string) {
    try {
      await this.sys.openDriverLink(key);
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
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

  protected onToggleMicrosoft(e: Event) {
    this.showMicrosoft.set((e.target as HTMLInputElement).checked);
  }

  protected timeOf(ms: number) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
