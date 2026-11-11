/**
 * Booking source in Studio: how to name it, count it and export it. The source is informational
 * (where bookings come from); it has no say in prices.
 */
import {
  agentGroup,
  time,
  type Booking,
  type BookingChannel,
  type BookingSource,
} from '@openbooking-sh/core';

const CHANNEL_LABELS: Record<BookingChannel, string> = {
  mcp: 'Other assistant',
  ucp: 'Other assistant',
  a2a: 'Other assistant',
  usp: 'Other assistant',
  website: 'Website',
  embed: 'Website embed',
  phone: 'Phone',
  walk_in: 'Walk-in',
  other: 'Other',
};

const CHANNEL_NAMES: Record<BookingChannel, string> = {
  mcp: 'MCP',
  ucp: 'UCP',
  a2a: 'A2A',
  usp: 'USP',
  website: 'the booking page',
  embed: 'the website embed',
  phone: 'a phone call',
  walk_in: 'a walk-in',
  other: 'another channel',
};

export const UNKNOWN_SOURCE = 'Unknown';

/**
 * The name Studio shows and filters by: the assistant's group when it is a known one (ChatGPT,
 * Gemini, Google, Claude, ...), else the channel. Bookings from before sources were recorded are
 * "Unknown".
 */
export function sourceLabel(source: BookingSource | undefined): string {
  if (!source) return UNKNOWN_SOURCE;
  const group = agentGroup(source.agent);
  if (group && group !== 'Other') return group;
  return CHANNEL_LABELS[source.channel];
}

/** One line for the booking drawer. The agent name is what the caller said about itself. */
export function sourceDetail(source: BookingSource | undefined): string {
  if (!source) return 'Not recorded (booked before sources were tracked)';
  const via = `via ${CHANNEL_NAMES[source.channel]}`;
  return source.agent ? `Reported by the assistant: ${source.agent}, ${via}` : `Booked ${via}`;
}

export interface SourceCount {
  source: string;
  confirmed: number;
  cancelled: number;
}

/**
 * Bookings per source for bookings created in `from`..`to` (venue-local dates, inclusive). Holds
 * that never became bookings (open or expired) are not counted.
 */
export function countBySource(
  bookings: readonly Booking[],
  timezone: string,
  range: { from?: string | undefined; to?: string | undefined } = {},
): SourceCount[] {
  const rows = new Map<string, SourceCount>();
  for (const b of bookings) {
    if (b.status !== 'confirmed' && b.status !== 'cancelled') continue;
    const created = time.localDate(new Date(b.created_at), timezone);
    if ((range.from && created < range.from) || (range.to && created > range.to)) continue;
    const key = sourceLabel(b.source);
    const row = rows.get(key) ?? { source: key, confirmed: 0, cancelled: 0 };
    row[b.status]++;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.confirmed - a.confirmed || a.source.localeCompare(b.source),
  );
}

// A spreadsheet runs a cell that starts with these as a formula; a customer name could be crafted.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * CSV of bookings with exactly the columns the Studio bookings list and drawer show about them
 * (no email, phone or notes): time, customer, service, with, guests, status, source.
 */
export function bookingsCsv(bookings: readonly Booking[], timezone: string): string {
  const head = [
    'Date',
    'Time',
    'Customer',
    'Service',
    'With',
    'Guests',
    'Status',
    'Source',
    'Channel',
    'Reported assistant',
    'Booking id',
  ];
  const lines = bookings.map((b) => {
    const start = new Date(b.slot.start);
    return [
      time.localDate(start, timezone),
      time.localTime(start, timezone),
      b.customer ? `${b.customer.first_name} ${b.customer.last_name}` : '',
      b.slot.offering.name,
      b.slot.resource?.label ?? '',
      String(b.slot.party_size.total),
      b.status,
      sourceLabel(b.source),
      b.source?.channel ?? '',
      b.source?.agent ?? '',
      b.booking_id,
    ]
      .map(cell)
      .join(',');
  });
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
