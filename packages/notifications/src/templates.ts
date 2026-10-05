/**
 * Email templates. Pure functions: booking + venue in, `{ subject, text, html }` out.
 * Customer names and notes come from AI agents, so every value is escaped in the HTML.
 */
import type { Booking, Venue } from '@openbooking-sh/core';
import { escapeHtml, formatAddress, formatAmount, formatWhen, formatWhenShort } from './format';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface CustomerEmailInput {
  booking: Booking;
  venue: Venue;
  /** View-or-cancel link for the customer. */
  manageUrl?: string;
}

export interface OwnerEmailInput {
  kind: 'new' | 'cancelled';
  booking: Booking;
  venue: Venue;
  /** Where the booking came from, e.g. "Claude", "Booking page". */
  channel: string;
}

type Row = [label: string, value: string];

export function renderConfirmationEmail(input: CustomerEmailInput): RenderedEmail {
  const { booking: b, venue } = input;
  const when = formatWhen(b.slot.start, venue.timezone);
  const rows: Row[] = [
    ['Service', b.slot.offering.name],
    ['When', when],
    ...(b.slot.resource ? [['With', b.slot.resource.label] as Row] : []),
    ...(b.slot.party_size.total > 1 ? [['Guests', String(b.slot.party_size.total)] as Row] : []),
    ['Price', b.slot.price ? formatAmount(b.slot.price) : 'Paid at the venue'],
    ...depositRows(b),
    ['Confirmation code', b.confirmation_code ?? '-'],
  ];
  return compose({
    subject: `Booking confirmed: ${b.slot.offering.name}, ${formatWhenShort(b.slot.start, venue.timezone)} at ${venue.name}`,
    heading: `You're booked at ${venue.name}`,
    intro: `Hi ${b.customer?.first_name ?? 'there'}, your booking is confirmed. A calendar invite is attached.`,
    rows,
    sections: [['Cancellation policy', b.slot.cancellation_policy.description]],
    venue,
    ...(input.manageUrl ? { link: [input.manageUrl, 'View or cancel your booking'] } : {}),
  });
}

export function renderCancellationEmail(input: CustomerEmailInput): RenderedEmail {
  const { booking: b, venue } = input;
  const c = b.cancellation;
  const rows: Row[] = [
    ['Service', b.slot.offering.name],
    ['When', formatWhen(b.slot.start, venue.timezone)],
    ...(c?.fee ? [['Cancellation fee', formatAmount(c.fee)] as Row] : []),
    ...(c?.refund ? [['Refund', formatAmount(c.refund)] as Row] : []),
    ...(b.confirmation_code ? [['Confirmation code', b.confirmation_code] as Row] : []),
  ];
  return compose({
    subject: `Booking cancelled: ${b.slot.offering.name}, ${formatWhenShort(b.slot.start, venue.timezone)} at ${venue.name}`,
    heading: 'Your booking is cancelled',
    intro: `Hi ${b.customer?.first_name ?? 'there'}, your booking at ${venue.name} has been cancelled.${
      c?.fee ? '' : ' There is no fee.'
    }`,
    rows,
    sections: [],
    venue,
  });
}

export function renderOwnerEmail(input: OwnerEmailInput): RenderedEmail {
  const { booking: b, venue, channel } = input;
  const who = b.customer ? `${b.customer.first_name} ${b.customer.last_name}` : 'Unknown customer';
  const short = formatWhenShort(b.slot.start, venue.timezone);
  const isNew = input.kind === 'new';
  const rows: Row[] = [
    ['Customer', who],
    ...(b.customer?.email ? [['Email', b.customer.email] as Row] : []),
    ...(b.customer?.phone_number ? [['Phone', b.customer.phone_number] as Row] : []),
    ['Service', b.slot.offering.name],
    ['When', formatWhen(b.slot.start, venue.timezone)],
    ...(b.slot.resource ? [['With', b.slot.resource.label] as Row] : []),
    ...(b.slot.party_size.total > 1 ? [['Guests', String(b.slot.party_size.total)] as Row] : []),
    ...(b.notes ? [['Notes', b.notes] as Row] : []),
    ...(isNew ? depositRows(b) : []),
    ...(!isNew && b.cancellation?.fee
      ? [['Cancellation fee', formatAmount(b.cancellation.fee)] as Row]
      : []),
    ['Booked via', channel],
    ...(b.confirmation_code ? [['Confirmation code', b.confirmation_code] as Row] : []),
  ];
  return compose({
    subject: `${isNew ? 'New booking' : 'Booking cancelled'}: ${b.slot.offering.name}, ${short} — ${who} (via ${channel})`,
    heading: isNew ? 'New booking' : 'Booking cancelled',
    intro: isNew
      ? `${who} booked ${b.slot.offering.name} through ${channel}.`
      : `${who} cancelled ${b.slot.offering.name}.`,
    rows,
    sections: [],
    venue,
    footer: 'Sent by OpenBooking. Manage bookings in your Studio.',
  });
}

function depositRows(b: Booking): Row[] {
  const d = b.slot.deposit;
  if (!d) return [];
  const status =
    b.payment.status === 'paid'
      ? 'paid'
      : b.payment.status === 'due_at_venue'
        ? 'payable at the venue'
        : 'pending';
  return [['Deposit', `${formatAmount(d.amount)} (${status})`]];
}

function compose(p: {
  subject: string;
  heading: string;
  intro: string;
  rows: Row[];
  sections: Row[];
  venue: Venue;
  link?: [url: string, label: string];
  footer?: string;
}): RenderedEmail {
  const address = formatAddress(p.venue.address);
  const contact = [p.venue.name, address, p.venue.phone_number].filter(Boolean) as string[];
  const footer = p.footer ?? 'Booked with OpenBooking.';

  const text = [
    p.heading,
    '',
    p.intro,
    '',
    ...p.rows.map(([k, v]) => `${k}: ${v}`),
    ...p.sections.flatMap(([k, v]) => ['', `${k}:`, v]),
    ...(p.link ? ['', `${p.link[1]}: ${p.link[0]}`] : []),
    '',
    ...contact,
    '',
    footer,
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f8f8f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0b1020">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e6e1;border-radius:14px;padding:24px">
<h1 style="font-size:20px;font-weight:600;margin:0 0 8px">${e(p.heading)}</h1>
<p style="margin:0 0 18px;color:#4a5068">${e(p.intro)}</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
${p.rows
  .map(
    ([k, v]) =>
      `<tr><td style="padding:6px 12px 6px 0;color:#8a90a3;vertical-align:top;white-space:nowrap">${e(k)}</td><td style="padding:6px 0">${e(v)}</td></tr>`,
  )
  .join('\n')}
</table>
${p.sections
  .map(
    ([k, v]) =>
      `<h2 style="font-size:14px;font-weight:600;margin:18px 0 4px">${e(k)}</h2><p style="margin:0;font-size:14px;color:#4a5068">${e(v)}</p>`,
  )
  .join('\n')}
${
  p.link
    ? `<p style="margin:22px 0 0"><a href="${e(p.link[0])}" style="display:inline-block;background:#2747e8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:500">${e(p.link[1])}</a></p>`
    : ''
}
<p style="margin:22px 0 0;font-size:13px;color:#8a90a3">${contact.map(e).join('<br>')}</p>
</div>
<p style="text-align:center;font-size:12px;color:#8a90a3;margin:14px 0 0">${e(footer)}</p>
</body></html>`;

  return { subject: p.subject, text, html };
}
