/**
 * Core ↔ UCP `dev.ucp.lodging.booking` mapping. Field names and shapes follow
 * UCP main@b0e81ade `source/schemas/lodging/booking.json` and `types/*.json`.
 */
import {
  time,
  type Booking,
  type BookingError,
  type Customer,
  type ErrorCode,
  type ErrorPayload,
  type Slot,
  type Venue,
} from '@openbooking/core';
import { OB, OPENBOOKING_EXT_VERSION, UCP, UCP_VERSION } from './constants';

export type UcpStatus =
  | 'incomplete'
  | 'requires_escalation'
  | 'ready_for_complete'
  | 'complete_in_progress'
  | 'completed'
  | 'canceled';

export type UcpSeverity =
  'recoverable' | 'requires_buyer_input' | 'requires_buyer_review' | 'unrecoverable';

export interface UcpMessage {
  type: 'error' | 'warning' | 'info';
  code?: string;
  content: string;
  severity?: UcpSeverity;
  path?: string;
  presentation?: 'notice' | 'disclosure';
  /** EXTENSION (sh.openbooking.booking). */
  suggested_next_action?: string;
}

export interface UcpTotal {
  type: string;
  display_text: string;
  amount: number;
}

/** `ucp` metadata on response bodies: version + active capabilities (only `version` required). */
export function responseMeta(extra: string[] = []) {
  const caps: Record<string, Array<{ version: string }>> = {
    [UCP.booking]: [{ version: UCP_VERSION }],
    [UCP.cancellationPolicy]: [{ version: UCP_VERSION }],
    [UCP.paymentTerms]: [{ version: UCP_VERSION }],
    [OB.booking]: [{ version: OPENBOOKING_EXT_VERSION }],
  };
  for (const name of extra) caps[name] = [{ version: OPENBOOKING_EXT_VERSION }];
  return { version: UCP_VERSION, capabilities: caps };
}

/**
 * Status mapping (core → UCP):
 *  held (no customer) → incomplete      (lead/booker missing; UCP requires a lead for ready_for_complete)
 *  held (customer)    → ready_for_complete
 *  confirmed          → completed
 *  cancelled|expired  → canceled
 * `requires_escalation` and `complete_in_progress` are never produced (no business UI handoff,
 * confirmation is synchronous).
 */
export function ucpStatus(b: Booking): UcpStatus {
  switch (b.status) {
    case 'held':
      return b.customer ? 'ready_for_complete' : 'incomplete';
    case 'confirmed':
      return 'completed';
    case 'cancelled':
    case 'expired':
      return 'canceled';
  }
}

export function currencyOf(venue: Venue, slot: Slot): string {
  return (
    venue.currency ??
    slot.price?.currency ??
    slot.deposit?.amount.currency ??
    slot.cancellation_policy.late_cancellation_fee?.currency ??
    'XXX'
  );
}

/** UCP `totals[]`: exactly one `subtotal` and one `total`, integer minor units. */
export function totalsFor(slot: Slot): UcpTotal[] {
  const amount = slot.price?.amount ?? 0;
  const priced = slot.price !== null;
  return [
    { type: 'subtotal', display_text: priced ? 'Subtotal' : 'Pay at venue', amount },
    { type: 'total', display_text: priced ? 'Total' : 'Total due now', amount },
  ];
}

export function cancellationPolicyEntry(slot: Slot) {
  const p = slot.cancellation_policy;
  return {
    type: UCP.cancellationPolicy,
    description: { plain: p.description },
    refundability: p.refundability,
    // EXTENSION (sh.openbooking.booking): structured schedule; UCP has free text only.
    free_cancellation_until: p.free_cancellation_until,
    late_cancellation_fee: p.late_cancellation_fee,
    no_show_fee: p.no_show_fee,
  };
}

/** UCP `dev.ucp.common.payment.terms` → `payment.terms[]`. */
export function paymentTermsFor(slot: Slot) {
  const d = slot.deposit;
  if (!d) return [];
  return [
    {
      id: 'deposit',
      title: 'Deposit',
      description: d.description,
      schedules: [
        {
          id: 'deposit',
          // `immediate` is the only schedule type UCP defines precisely; `at_property` appears in
          // lodging docs for pay-at-venue.
          type: d.due === 'at_confirmation' ? 'immediate' : 'at_property',
          description: d.description,
          amount: d.amount.amount,
        },
      ],
    },
  ];
}

export function stayFor(slot: Slot, venue: Venue) {
  const tz = venue.timezone;
  return {
    id: slot.slot_id,
    // SPEC AMBIGUITY: UCP leaves end_date semantics open (PR #870). For same-day slots both are
    // the local date; for slots crossing midnight end_date is the local end date.
    stay_dates: {
      start_date: time.localDate(new Date(slot.start), tz),
      end_date: time.localDate(new Date(slot.end), tz),
    },
    accommodation_type: {
      id: slot.resource?.kind ?? 'resource',
      title: slot.resource?.label ?? 'Reservation',
    },
    rate_plan: { id: slot.offering.id, title: slot.offering.name },
    occupancy: {
      total: slot.party_size.total,
      ...(slot.party_size.adults !== undefined ? { adults: slot.party_size.adults } : {}),
      ...(slot.party_size.children !== undefined ? { children: slot.party_size.children } : {}),
    },
    totals: totalsFor(slot),
    // EXTENSION (sh.openbooking.booking)
    time_slot: { start_at: slot.start, end_at: slot.end, timezone: tz },
  };
}

export function bookerFor(c: Customer | null) {
  if (!c) return undefined;
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    ...(c.email ? { email: c.email } : {}),
    ...(c.phone_number ? { phone_number: c.phone_number } : {}),
  };
}

/** Booker (UCP) → Customer (core). Returns undefined when absent. */
export function customerFrom(booker: unknown): Record<string, unknown> | undefined {
  if (!booker || typeof booker !== 'object') return undefined;
  const b = booker as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['first_name', 'last_name', 'email', 'phone_number'])
    if (b[k] !== undefined) out[k] = b[k];
  return Object.keys(out).length ? out : undefined;
}

const UCP_CODE: Partial<Record<ErrorCode, string>> = {
  slot_unavailable: 'inventory_exhausted',
  party_size_unsupported: 'occupancy_exceeded_capacity',
  payment_failed: 'payment_failed',
};

const RECOVERABLE: ReadonlySet<ErrorCode> = new Set([
  'validation_error',
  'user_confirmation_required',
  'customer_details_required',
  'payment_required',
  'payment_failed',
  'provider_error',
]);

/**
 * Core error → UCP message. Severity: errors the platform/agent can fix in-protocol are
 * `recoverable` (we never use `requires_*`, which would imply `requires_escalation` +
 * `continue_url`); everything else is `unrecoverable`.
 */
export function errorMessage(e: ErrorPayload | BookingError): UcpMessage {
  const payload = 'toJSON' in e ? e.toJSON() : e;
  return {
    type: 'error',
    code: UCP_CODE[payload.code] ?? payload.code,
    content: payload.message,
    severity: RECOVERABLE.has(payload.code) ? 'recoverable' : 'unrecoverable',
    ...(payload.code === 'customer_details_required' ? { path: '$.booker' } : {}),
    suggested_next_action: payload.suggested_next_action,
  };
}

function statusMessages(b: Booking): UcpMessage[] {
  const out: UcpMessage[] = [];
  const p = b.slot.cancellation_policy;
  if (b.status === 'held' && !b.customer) {
    out.push({
      type: 'error',
      code: 'customer_details_required',
      content:
        'Booker first_name, last_name and email or phone_number are required before completion.',
      severity: 'recoverable',
      path: '$.booker',
      suggested_next_action: 'PUT the session with a booker, then POST /complete.',
    });
  }
  if (b.status === 'held' && p.refundability === 'non_refundable') {
    out.push({
      type: 'warning',
      code: UCP.cancellationPolicy,
      content: p.description,
      presentation: 'disclosure',
    });
  }
  if (b.status === 'held') {
    out.push({
      type: 'info',
      content: `Inventory is held until ${b.expires_at}. Completion requires user_confirmed=true after the user explicitly approves.`,
    });
  }
  if (b.status === 'expired') {
    out.push({
      type: 'info',
      content: `The hold expired at ${b.expires_at ?? 'its expiry time'}; inventory was released.`,
    });
  }
  return out;
}

export function toUcpSession(b: Booking, venue: Venue, extraMessages: UcpMessage[] = []) {
  const currency = currencyOf(venue, b.slot);
  const terms = paymentTermsFor(b.slot);
  const session: Record<string, unknown> = {
    ucp: responseMeta(),
    id: b.booking_id,
    status: ucpStatus(b),
    property: {
      id: venue.id,
      name: venue.name,
      ...(venue.address ? { address: venue.address } : {}),
    },
    stays: [stayFor(b.slot, venue)],
    ...(b.customer ? { booker: bookerFor(b.customer) } : {}),
    currency,
    totals: totalsFor(b.slot),
    links: [],
    messages: [...extraMessages, ...statusMessages(b)],
    policies: [cancellationPolicyEntry(b.slot)],
    ...(b.status === 'held' && b.expires_at ? { expires_at: b.expires_at } : {}),
    ...(terms.length ? { payment: { instruments: [], terms } } : {}),
    ...(b.status === 'confirmed' && b.confirmation_code
      ? {
          confirmation: {
            id: b.confirmation_code,
            label: `Confirmation code ${b.confirmation_code}`,
          },
        }
      : {}),
  };
  return session;
}

/** UCP `error_response` (additionalProperties: false → no extension fields at the root). */
export function errorResponse(e: ErrorPayload | BookingError) {
  return { ucp: { version: UCP_VERSION, status: 'error' as const }, messages: [errorMessage(e)] };
}

export function offerFor(slot: Slot, venue: Venue) {
  const terms = paymentTermsFor(slot);
  return {
    ...stayFor(slot, venue),
    currency: currencyOf(venue, slot),
    policies: [cancellationPolicyEntry(slot)],
    ...(terms.length ? { payment_terms: terms } : {}),
  };
}
