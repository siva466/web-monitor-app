export function formatBytes(n: number | null): string {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function formatAge(ms: number, now = Date.now()): string {
  const days = Math.floor((now - ms) / 86400000);
  if (days < 1) return 'today';
  if (days < 31) return `${days} day${days > 1 ? 's' : ''} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? 's' : ''} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years > 1 ? 's' : ''} ago`;
}

export function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // Electron prefixes errors that cross from the main process: "Error invoking remote method 'x': Error: ..."
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

// Stable colour per name, for the letter avatars.
export function avatarHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// Empty values always sort last, whichever direction is chosen.
export function compareValues(x: string | number | null | undefined, y: string | number | null | undefined, dir: 1 | -1): number {
  if (x === y) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
}
