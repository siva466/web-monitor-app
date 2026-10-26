import { compareValues, errorText, formatAge, formatBytes, formatMinutes, formatUptime } from './format';

describe('formatMinutes', () => {
  it('shows minutes, hours and minutes, or days and hours; missing values as a dash', () => {
    expect(formatMinutes(0.2)).toBe('0 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(97.5)).toBe('1 h 38 min');
    expect(formatMinutes(120)).toBe('2 h 0 min');
    expect(formatMinutes(3113.3)).toBe('2 d 3 h');
    expect(formatMinutes(null)).toBe('-');
    expect(formatMinutes(undefined)).toBe('-');
    expect(formatMinutes(NaN)).toBe('-');
  });
});

describe('formatAge', () => {
  it('reads as days, months and years', () => {
    const now = Date.UTC(2026, 9, 25);
    const ago = (days: number) => now - days * 86400000;
    expect(formatAge(ago(0.2), now)).toBe('today');
    expect(formatAge(ago(1), now)).toBe('1 day ago');
    expect(formatAge(ago(15), now)).toBe('15 days ago');
    expect(formatAge(ago(65), now)).toBe('2 months ago');
    expect(formatAge(ago(800), now)).toBe('2 years ago');
  });
});

describe('errorText', () => {
  it('drops the prefix Electron adds to errors from the main process', () => {
    expect(errorText(new Error("Error invoking remote method 'startup:set': Error: Needs administrator rights."))).toBe('Needs administrator rights.');
    expect(errorText(new Error('plain'))).toBe('plain');
    expect(errorText('text')).toBe('text');
  });
});

describe('formatBytes', () => {
  it('formats units and missing values', () => {
    expect(formatBytes(null)).toBe('-');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25439199232)).toBe('23.7 GB');
    expect(formatBytes(200 * 1024 ** 2)).toBe('200 MB');
  });
});

describe('formatUptime', () => {
  it('shows the two largest units', () => {
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(formatUptime(2 * 86400 + 4 * 3600)).toBe('2d 4h');
  });
});

describe('compareValues', () => {
  it('sorts numbers and text, with empty values last in both directions', () => {
    expect(compareValues(1, 2, 1)).toBeLessThan(0);
    expect(compareValues(1, 2, -1)).toBeGreaterThan(0);
    expect(compareValues('a', 'B', 1)).toBeLessThan(0);
    expect(compareValues(null, 5, 1)).toBeGreaterThan(0);
    expect(compareValues(null, 5, -1)).toBeGreaterThan(0);
    expect(compareValues(5, undefined, -1)).toBeLessThan(0);
  });
});
