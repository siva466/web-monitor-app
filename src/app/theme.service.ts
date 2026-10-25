import { Injectable, signal } from '@angular/core';
import { ThemeMode } from './api';

const KEY = 'theme';

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(stored());
  private readonly darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');

  constructor() {
    this.apply();
    this.darkQuery?.addEventListener('change', () => this.apply());
    window.api?.setTheme(this.mode());
  }

  set(mode: ThemeMode) {
    this.mode.set(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // storage blocked: the choice just isn't remembered
    }
    this.apply();
    window.api?.setTheme(mode); // also themes the window frame
  }

  private apply() {
    const m = this.mode();
    const dark = m === 'dark' || (m === 'system' && !!this.darkQuery?.matches);
    document.documentElement.dataset['bsTheme'] = dark ? 'dark' : 'light';
  }
}
