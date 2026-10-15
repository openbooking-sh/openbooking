/**
 * OpenBooking booking/hold → USP `Booking` / `Hold` (spec sections 4.2 and 5.2).
 *
 * A USP hold and the booking made from it are one record for us: the engine booking is `held`
 * until it is confirmed. The USP hold id is the booking id with a `hold_` prefix so the two
 * resources stay distinct on the wire.
 */
import { evaluateBookingCancellation, type Booking, type Venue } from '@openbooking-sh/core';
import { OB_NEXT_ACTION } from './constants';
import { isoDuration, serviceId } from './mapping';
import { message } from './protocol';

export type ConsentMode = 'action' | 'commit';

/** Action type for "the buyer must confirm on the business's page" (a non-payment action). */
export const CONFIRMATION_ACTION = 'sh.openbooking.confirmation';

export const holdId = (bookingId: string) => `hold_${bookingId}`;
export const bookingIdOfHold = (id: string): string | undefined =>
  id.startsWith('hold_') && id.length > 5 ? id.slice(5) : undefined;

export interface BookingContext {
  venue: Venue;
  multiVenue: boolean;
  mode: ConsentMode;
  now: Date;
  /** Where the buyer confirms a held booking (consent `action`). */
  continueUrl?: (b: Booking) => string;
  /** Where the customer manages a confirmed booking. */
  bookingUrl?: (b: Booking) => string | undefined;
}

const ISO_DURATION_MINUTES = (b: Booking) =>
  Math.round((Date.parse(b.slot.end) - Date.parse(b.slot.start)) / 60_000);

/** USP `Hold` for an engine booking. */
export function toHold(b: Booking, ctx: Pick<BookingContext, 'venue' | 'multiVenue'>) {
  const status =
    b.status === 'held'
      ? 'active'
      : b.status === 'confirmed'
        ? 'converted'
        : b.status === 'expired'
          ? 'expired'
          : 'released';
  return {
    id: holdId(b.booking_id),
    slot_id: b.slot.slot_id,
    service_id: serviceId(ctx.venue.id, b.slot.offering.id, ctx.multiVenue),
    spots: b.slot.party_size.total,
    expires_at: b.expires_at ?? b.slot.start,
    status,
  };
}

/**
 * USP `Booking`, or null when the booking cannot be expressed: USP requires the buyer's email,
 * and bookings made elsewhere may have only a phone number.
 */
export function toBooking(b: Booking, ctx: BookingContext) {
  const c = b.customer;
  if (!c?.email) return null;

  const status =
    b.status === 'confirmed'
      ? 'confirmed'
      : b.status === 'held'
        ? ctx.mode === 'action'
          ? 'requires_action'
          : 'pending'
        : 'canceled';

  const currency = b.slot.price?.currency ?? ctx.venue.currency;
  const open = status === 'requires_action' || status === 'pending';
  const bookingUrl = ctx.bookingUrl?.(b);
  const terms = b.status === 'confirmed' ? cancellationTerms(b, ctx.now) : undefined;

  return {
    id: b.booking_id,
    service_id: serviceId(ctx.venue.id, b.slot.offering.id, ctx.multiVenue),
    service_name: b.slot.offering.name,
    slot: {
      id: b.slot.slot_id,
      start: b.slot.start,
      end: b.slot.end,
      duration: isoDuration(ISO_DURATION_MINUTES(b)),
    },
    buyer: {
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      ...(c.phone_number ? { phone_number: c.phone_number } : {}),
    },
    party_size: b.slot.party_size.total,
    status,
    ...(open ? { confirmation_mode: 'auto' } : {}),
    // Nothing is payable online here: any price is settled at the business (see the catalog).
    payment: {
      status: 'not_required',
      timing: 'at_service',
      amount_due: 0,
      ...(currency ? { currency } : {}),
    },
    ...(status === 'requires_action' && ctx.continueUrl
      ? {
          actions: [
            {
              type: CONFIRMATION_ACTION,
              status: 'pending',
              continue_url: ctx.continueUrl(b),
              ...(b.expires_at ? { expires_at: b.expires_at } : {}),
              message: message(
                'info',
                'confirmation_required',
                'The buyer must review the time, price and cancellation terms and confirm on the business page. Nothing is booked until they do.',
                { severity: 'requires_buyer_review' },
              ),
            },
          ],
        }
      : {}),
    ...(b.notes ? { notes: b.notes } : {}),
    ...(b.slot.resource
      ? {
          resources: [
            {
              ...(b.slot.resource.id ? { id: b.slot.resource.id } : {}),
              type: b.slot.resource.kind,
              name: b.slot.resource.label,
            },
          ],
        }
      : {}),
    location: { id: ctx.venue.id, name: ctx.venue.name },
    ...(bookingUrl ? { booking_url: bookingUrl } : {}),
    ...(b.status === 'held' && b.expires_at ? { expires_at: b.expires_at } : {}),
    ...(status === 'canceled' ? { cancellation: cancellationOf(b) } : {}),
    ...(terms ? { 'sh.openbooking.cancellation_terms': terms } : {}),
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

function cancellationOf(b: Booking) {
  if (b.status === 'expired') {
    return {
      reason_code: 'hold_expired',
      canceled_by: 'system',
      canceled_at: b.expires_at ?? b.updated_at,
    };
  }
  return {
    ...(b.cancellation?.reason ? { reason: b.cancellation.reason } : {}),
    canceled_by: 'buyer',
    fee: b.cancellation?.fee?.amount ?? 0,
    ...(b.cancellation?.refund ? { refund_amount: b.cancellation.refund.amount } : {}),
    canceled_at: b.cancelled_at ?? b.updated_at,
  };
}

/**
 * What cancelling would cost right now, as an extension on the booking. USP publishes only
 * relative policies on the service, so an agent would otherwise have to do time arithmetic before
 * it could tell the user the price of cancelling.
 */
export function cancellationTerms(b: Booking, now: Date) {
  const outcome = evaluateBookingCancellation(b, now);
  const policy = b.slot.cancellation_policy;
  if (!outcome.allowed) {
    return { allowed: false, description: policy.description };
  }
  return {
    allowed: true,
    free: outcome.free,
    ...(policy.free_cancellation_until ? { free_until: policy.free_cancellation_until } : {}),
    fee_now: outcome.fee?.amount ?? 0,
    ...(outcome.refund ? { refund_now: outcome.refund.amount } : {}),
    ...(outcome.fee ? { currency: outcome.fee.currency } : {}),
    description: policy.description,
    [OB_NEXT_ACTION]: outcome.free
      ? 'Cancelling is free; tell the buyer before cancelling.'
      : 'Cancelling costs a fee; tell the buyer the amount and get their approval first.',
  };
}
