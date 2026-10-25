import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { AppUpdate } from '../api';
import { avatarHue, errorText } from '../format';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

@Component({
  selector: 'app-updates',
  templateUrl: './updates.html',
})
export class Updates implements OnInit {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly hue = avatarHue;
  protected readonly items = signal<AppUpdate[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly checkedAt = signal<number | null>(null);
  protected readonly updatingId = signal<string | null>(null); // the app being updated right now
  protected readonly heldBack = computed(() => this.items().filter((i) => i.explicit).length);

  ngOnInit() {
    this.load();
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.items.set(await this.sys.appUpdates());
      this.checkedAt.set(Date.now());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    }
    this.loading.set(false);
  }

  // Only plain winget updates: held-back ones and ones from other sources are updated elsewhere.
  protected canUpdate(u: AppUpdate) {
    return !u.explicit && u.source === 'winget';
  }

  protected async update(u: AppUpdate) {
    const ok = await this.ui.confirm({
      title: `Update ${u.name}?`,
      body: `From ${u.version} to ${u.available}, from winget's community catalogue. Close ${u.name} first if it is open. Windows may ask for permission.`,
      confirmLabel: 'Update',
    });
    if (!ok) return;
    this.updatingId.set(u.id);
    this.ui.toast(`Updating ${u.name}. If Windows asks for permission, choose Yes. No prompt in sight? Look for a flashing shield in the taskbar.`, 'info');
    try {
      const r = await this.sys.upgradeApp(u.id);
      if (r.updated) this.ui.toast(`${u.name} is now version ${r.to}.`, 'success');
      else this.ui.toast(`${u.name} was not updated. ${r.message ?? ''}`.trim(), 'error');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.updatingId.set(null);
    await this.load();
  }

  protected timeOf(ms: number) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
