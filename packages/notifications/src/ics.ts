/**
 * iCalendar (RFC 5545) invites, so a confirmed booking lands in the customer's calendar and a
 * cancellation removes it again (same UID, METHOD:CANCEL).
 */
import type { Booking, Venue } from '@openbooking/core';
import { formatAddress } from './format';

export interface IcsOptions {
  booking: Booking;
  venue: Venue;
  method: 'REQUEST' | 'CANCEL';
  /** Business email shown as organizer. */
  organizerEmail?: string;
  /** Manage link (view or cancel the booking). */
  url?: string;
  now?: Date;
}

export function buildIcs(opts: IcsOptions): string {
  const { booking: b, venue, method } = opts;
  const cancel = method === 'CANCEL';
  const description = [
    b.confirmation_code ? `Confirmation code: ${b.confirmation_code}` : '',
    `Cancellation policy: ${b.slot.cancellation_policy.description}`,
    opts.url ? `View or cancel: ${opts.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const location = formatAddress(venue.address);
  const customer = b.customer;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenBooking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${b.booking_id}@openbooking.sh`,
    `DTSTAMP:${utc(opts.now ?? new Date())}`,
    `DTSTART:${utc(new Date(b.slot.start))}`,
    `DTEND:${utc(new Date(b.slot.end))}`,
    `SUMMARY:${text(`${b.slot.offering.name} at ${venue.name}`)}`,
    ...(location ? [`LOCATION:${text(location)}`] : []),
    `DESCRIPTION:${text(description)}`,
    ...(opts.url ? [`URL:${opts.url}`] : []),
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${cancel ? 1 : 0}`,
    ...(opts.organizerEmail
      ? [`ORGANIZER;CN=${param(venue.name)}:mailto:${opts.organizerEmail}`]
      : []),
    ...(customer?.email
      ? [
          `ATTENDEE;CN=${param(`${customer.first_name} ${customer.last_name}`)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${customer.email}`,
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** `20261009T130000Z` */
function utc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function text(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Parameter values are quoted; quotes themselves aren't allowed. */
function param(v: string): string {
  return `"${v.replace(/"/g, "'")}"`;
}

/** Fold lines longer than 75 octets (RFC 5545 §3.1) without splitting UTF-8 characters. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    // Continuation lines start with a space, which counts toward their 75.
    if (octets + size > 75) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n');
}
