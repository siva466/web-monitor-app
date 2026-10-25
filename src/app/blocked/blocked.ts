import { Component, OnInit, inject, signal } from '@angular/core';
import { BlockedList, BlockedRow } from '../api';
import { errorText } from '../format';
import { Icon } from '../icon';
import { SystemService } from '../system.service';
import { UiService } from '../ui.service';

@Component({
  imports: [Icon],
  selector: 'app-blocked',
  templateUrl: './blocked.html',
})
export class Blocked implements OnInit {
  private readonly sys = inject(SystemService);
  private readonly ui = inject(UiService);

  protected readonly data = signal<BlockedList | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  ngOnInit() {
    this.load();
  }

  protected async load() {
    this.loading.set(true);
    try {
      this.data.set(await this.sys.listBlocked());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorText(e));
    }
    this.loading.set(false);
  }

  protected kindLabel(r: BlockedRow) {
    return r.kind === 'policy' ? 'Blocked by app control' : r.kind === 'audit' ? 'Audit only' : 'Refused by the program';
  }

  protected when(iso: string | null) {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? '-' : new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected whatItIs(r: BlockedRow) {
    const parts = [r.description ?? r.product, r.company ?? r.publisher ?? r.signer].filter((x, i, a) => !!x && a.indexOf(x) === i);
    return parts.join(' · ');
  }

  protected async openSecurity() {
    try {
      await this.sys.openDriverLink('app-control');
    } catch (e) {
      this.ui.toast(errorText(e), 'error');
    }
  }
}
