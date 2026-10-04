/**
 * Minimal, dependency-free time-zone helpers built on Intl. Providers think in venue-local wall
 * time ("19:00 in Europe/Oslo"); the wire format is ISO 8601 with an explicit offset.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (e.g. +120 for CEST). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const t = Math.floor(instant.getTime() / 1000) * 1000;
  const p = localParts(new Date(t), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - t) / 60_000);
}

/** Convert a venue-local date (`YYYY-MM-DD`) and time (`HH:MM`) to an instant. */
export function zonedToInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMinutes(new Date(guess), timeZone);
  let t = guess - off1 * 60_000;
  const off2 = offsetMinutes(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2 * 60_000;
  return new Date(t);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** Format an instant as ISO 8601 with the venue's offset, e.g. `2026-10-03T19:00:00+02:00`. */
export function formatInZone(instant: Date, timeZone: string): string {
  const off = offsetMinutes(instant, timeZone);
  const p = localParts(instant, timeZone);
  const sign = off >= 0 ? '+' : '-';
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** Venue-local `YYYY-MM-DD` for an instant. */
export function localDate(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Venue-local `HH:MM` for an instant. */
export function localTime(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Weekday (0 = Sunday) of a calendar date, independent of time zone. */
export function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `YYYY-MM-DD` shifted by `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Minutes since midnight for `HH:MM`. */
export function minutesOfDay(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** `HH:MM` for minutes since midnight (wraps past 24h). */
export function timeOfMinutes(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
