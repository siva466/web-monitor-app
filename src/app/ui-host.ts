import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { Icon } from './icon';
import { UiService } from './ui.service';

// Renders the confirm dialog and the toasts that UiService asks for. Place it once, in the app shell.
@Component({
  selector: 'app-ui-host',
  imports: [Icon],
  styleUrl: './ui-host.scss',
  template: `
    @if (ui.dialog(); as d) {
      <dialog
        #dlg
        class="dlg"
        aria-labelledby="dlg-title"
        aria-describedby="dlg-body"
        (cancel)="$event.preventDefault(); ui.answer(false)"
        (click)="onBackdrop($event)"
      >
        <div class="dlg-content">
          <h2 id="dlg-title">{{ d.title }}</h2>
          <p id="dlg-body">{{ d.body }}</p>
          @if (d.items?.length) {
            <ul>
              @for (item of d.items; track item) {
                <li>{{ item }}</li>
              }
            </ul>
          }
        </div>
        <div class="dlg-actions">
          <button type="button" class="btn btn-quiet" autofocus (click)="ui.answer(false)">Cancel</button>
          <button type="button" class="btn" [class.btn-danger]="d.danger" [class.btn-primary]="!d.danger" (click)="ui.answer(true)">
            {{ d.confirmLabel }}
          </button>
        </div>
      </dialog>
    }

    <div class="toasts" role="status" aria-live="polite">
      @for (t of ui.toasts(); track t.id) {
        <div class="toast-item" [attr.data-kind]="t.kind">
          <app-icon [name]="t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'" />
          <span>{{ t.text }}</span>
          <button type="button" class="icon-btn" aria-label="Dismiss" (click)="ui.dismiss(t.id)"><app-icon name="x" /></button>
        </div>
      }
    </div>
  `,
})
export class UiHost {
  protected readonly ui = inject(UiService);
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    // The native <dialog> gives focus trapping, Esc and an inert background.
    effect(() => {
      const el = this.dlg()?.nativeElement;
      if (el && !el.open) el.showModal();
    });
  }

  protected onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) this.ui.answer(false);
  }
}
