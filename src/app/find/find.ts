import { Component, inject, signal } from '@angular/core';
import { AppDetails, AppHit } from '../api';
import { avatarHue, errorText } from '../format';
import { Icon } from '../icon';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

@Component({
  imports: [Icon],
  selector: 'app-find',
  templateUrl: './find.html',
})
export class Find {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly installing = signal(false);
  protected readonly hue = avatarHue;
  protected readonly query = signal('');
  protected readonly results = signal<AppHit[] | null>(null); // null = nothing searched yet
  protected readonly searching = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly details = signal<AppDetails | null>(null);
  protected readonly loadingDetails = signal(false);
  protected readonly detailsError = signal<string | null>(null);

  protected onInput(e: Event) {
    this.query.set((e.target as HTMLInputElement).value);
  }

  protected async search() {
    const q = this.query().trim();
    if (!q) return;
    this.searching.set(true);
    this.selectedId.set(null);
    this.details.set(null);
    this.detailsError.set(null);
    try {
      this.results.set(await this.sys.searchApps(q));
      this.error.set(null);
    } catch (e) {
      this.results.set(null);
      this.error.set(errorText(e));
    }
    this.searching.set(false);
  }

  protected async install(d: AppDetails) {
    const ok = await this.ui.confirm({
      title: `Install ${d.name}?`,
      body: `From winget's community catalogue. Publisher: ${d.publisher ?? 'not stated'}. License: ${d.license ?? 'not stated'} (${d.hint.label.toLowerCase()}). Windows may ask for permission.`,
      confirmLabel: 'Install',
    });
    if (!ok) return;
    this.installing.set(true);
    this.ui.toast(`Installing ${d.name}. If Windows asks for permission, choose Yes. No prompt in sight? Look for a flashing shield in the taskbar.`, 'info');
    try {
      const r = await this.sys.installApp(d.id);
      if (r.installed) this.ui.toast(`${d.name} is installed. It now appears under Software.`, 'success');
      else this.ui.toast(`${d.name} was not installed. ${r.message ?? ''}`.trim(), 'error');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
    this.installing.set(false);
  }

  protected async select(hit: AppHit) {
    this.selectedId.set(hit.id);
    this.details.set(null);
    this.detailsError.set(null);
    this.loadingDetails.set(true);
    try {
      const d = await this.sys.appDetails(hit.id);
      if (this.selectedId() === hit.id) this.details.set(d); // ignore an answer for an app that is no longer selected
    } catch (e) {
      if (this.selectedId() === hit.id) this.detailsError.set(errorText(e));
    }
    if (this.selectedId() === hit.id) this.loadingDetails.set(false);
  }
}
