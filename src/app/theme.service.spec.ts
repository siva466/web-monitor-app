import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => localStorage.clear());

  it('applies and remembers the chosen theme', () => {
    const theme = TestBed.inject(ThemeService);
    theme.set('dark');
    expect(document.documentElement.dataset['bsTheme']).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    theme.set('light');
    expect(document.documentElement.dataset['bsTheme']).toBe('light');
  });

  it('falls back to light when the system preference is unknown', () => {
    const theme = TestBed.inject(ThemeService);
    theme.set('system');
    expect(document.documentElement.dataset['bsTheme']).toBe('light');
  });
});
