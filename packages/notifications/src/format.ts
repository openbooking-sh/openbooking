import { time, type Address, type Money } from '@openbooking/core';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "650 NOK", or "649.50 NOK" when there are minor units. */
export function formatAmount(m: Money): string {
  const major = m.amount / 100;
  return `${Number.isInteger(major) ? major : major.toFixed(2)} ${m.currency}`;
}

/** "Friday 9 October, 15:00" in the venue's time zone. */
export function formatWhen(iso: string, timezone: string): string {
  const p = time.localParts(new Date(iso), timezone);
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}, ${time.localTime(new Date(iso), timezone)}`;
}

/** "Fri 9 Oct 15:00", for subject lines. */
export function formatWhenShort(iso: string, timezone: string): string {
  const p = time.localParts(new Date(iso), timezone);
  return `${WEEKDAYS[p.weekday]!.slice(0, 3)} ${p.day} ${MONTHS[p.month - 1]!.slice(0, 3)} ${time.localTime(new Date(iso), timezone)}`;
}

export function formatAddress(a: Address | undefined): string {
  if (!a) return '';
  const city = [a.postal_code, a.address_locality].filter(Boolean).join(' ');
  return [a.street_address, city, a.address_region].filter(Boolean).join(', ');
}

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
