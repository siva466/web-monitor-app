import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error' | 'info';
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  items?: string[];
}

interface OpenDialog extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toasts = signal<Toast[]>([]);
  readonly dialog = signal<OpenDialog | null>(null);
  private nextId = 0;

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++this.nextId;
    this.toasts.update((t) => [...t, { id, text, kind }]);
    // long messages (for example why an installer was blocked) stay long enough to read: about 60 ms per character, at most 20 s
    setTimeout(() => this.dismiss(id), Math.min(20000, Math.max(kind === 'error' ? 8000 : 4000, text.length * 60)));
  }

  dismiss(id: number) {
    this.toasts.update((t) => t.filter((x) => x.id !== id));
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    this.dialog()?.resolve(false); // a new question replaces an unanswered one
    return new Promise((resolve) => this.dialog.set({ ...options, resolve }));
  }

  answer(ok: boolean) {
    const d = this.dialog();
    this.dialog.set(null);
    d?.resolve(ok);
  }
}
