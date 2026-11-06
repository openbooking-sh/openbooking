import type { Money } from '@openbooking-sh/client';

/** `65000` NOK in minor units → "NOK 650.00" (or the locale's own style). */
export function formatMoney(money: Money, locale?: string): string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency });
  // Minor units: 100 per unit for most currencies, 1 for JPY and so on.
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(money.amount / 10 ** digits);
}

/** "Fri 16 Oct, 10:00": the time as the venue sees it, whatever the visitor's time zone. */
export function formatSlotTime(iso: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatClock(iso: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Today's date at the venue as `YYYY-MM-DD`. */
export function todayAt(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
