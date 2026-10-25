import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemeMode } from './api';
import { Icon } from './icon';
import { ThemeService } from './theme.service';
import { UiHost } from './ui-host';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, UiHost],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly theme = inject(ThemeService);
  protected readonly modes: { id: ThemeMode; label: string; icon: string }[] = [
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'system', label: 'Match Windows', icon: 'monitor' },
    { id: 'dark', label: 'Dark', icon: 'moon' },
  ];
}
