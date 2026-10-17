/**
 * What the booking API sends and accepts. Prices are integers in minor units (`65000` = 650.00),
 * times are ISO 8601 with the venue offset. These types are checked against the server's schemas
 * in `@openbooking-sh/booking-page`'s tests, so they cannot drift from what the API really does.
 */

export interface Money {
  /** Integer amount in minor units, e.g. cents or øre. */
  amount: number;
  /** ISO 4217 code, e.g. `NOK`. */
  currency: string;
}

export interface Address {
  street_address?: string;
  address_locality?: string;
  address_region?: string;
  postal_code?: string;
  address_country?: string;
}

export interface CancellationPolicy {
  refundability: 'refundable' | 'partially_refundable' | 'non_refundable';
  /** Show this to the customer as written. */
  description: string;
  /** Cancel before this instant for free. `null` = never free. */
  free_cancellation_until: string | null;
  late_cancellation_fee: Money | null;
  no_show_fee: Money | null;
}

export interface DepositTerms {
  amount: Money;
  due: 'at_confirmation' | 'at_venue';
  description: string;
}

/** A name plus an email address or a phone number (or both). */
export interface Customer {
  first_name: string;
  last_name: string;
  email?: string;
  phone_number?: string;
}

export type BookingStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';

export interface Info {
  venue: {
    name: string;
    description: string | null;
    address: Address | null;
    phone_number: string | null;
    /** IANA time zone, e.g. `Europe/Oslo`. */
    timezone: string;
    currency: string | null;
  };
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    duration_minutes: number;
    /** Per person. `null` = priced at the venue. */
    price: Money | null;
  }>;
  staff: Array<{ id: string; name: string }>;
  profile: { category?: string; email?: string; website?: string };
  /** The public booking page, for people. */
  booking_page: string;
}

export interface Slot {
  /** Opaque. Pass it to `hold` to reserve this time. */
  slot_id: string;
  start: string;
  end: string;
  offering: { id: string; name: string };
  resource: { id: string | null; label: string } | null;
  price: Money | null;
  deposit: DepositTerms | null;
  cancellation_policy: CancellationPolicy;
}

export interface Availability {
  date: string;
  slots: Slot[];
}

export interface Booking {
  booking_id: string;
  status: BookingStatus;
  start: string;
  end: string;
  offering: { id: string; name: string };
  /** Staff member or table, by name. */
  resource: string | null;
  party_size: number;
  price: Money | null;
  deposit: DepositTerms | null;
  cancellation_policy: CancellationPolicy;
  /** Set while held: the hold is released at this instant. */
  expires_at: string | null;
  /** Set once confirmed. */
  confirmation_code: string | null;
}

/** A booking read with its customer and cancellation outcome. */
export interface BookingDetail extends Booking {
  customer: { first_name: string; last_name: string } | null;
  cancellation: { reason: string | null; fee: Money | null; refund: Money | null } | null;
}

/** A confirmed booking seen by someone who only has its id: no code, no name. */
export type ConfirmedHold = Omit<Booking, 'expires_at' | 'confirmation_code'>;

export interface ConfirmedBooking extends Booking {
  /** Where the customer can view or cancel the booking. Keep the link private. */
  manage_url: string | null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AvailabilityParams {
  /** `YYYY-MM-DD`, in the venue's time zone. */
  date: string;
  /** A service id from `info()`. */
  service?: string;
  /** A staff id from `info()`. */
  staff?: string;
  /** Number of guests. Default 1. */
  party?: number;
  /** Earliest start, `HH:MM`. */
  time_from?: string;
  /** Latest start, `HH:MM`. */
  time_to?: string;
}

export interface WriteOptions {
  /**
   * Identifies this intended action. Repeating a call with the same key never books twice, so a
   * retry after a network error must reuse it. Defaults to a new random key for each call; pass
   * your own, and keep it, when you want to retry the same call safely.
   */
  idempotency_key?: string;
}

export interface HoldInput extends WriteOptions {
  slot_id: string;
}

export interface ConfirmInput extends WriteOptions {
  booking_id: string;
  /**
   * The customer's explicit yes, after seeing the time, price and cancellation terms. Written as
   * `true` on purpose: never set it on the customer's behalf.
   */
  user_confirmed: true;
  customer: Customer;
  notes?: string;
  /** The Stripe session id the customer came back with, for bookings with an online deposit. */
  payment_token?: string;
}

export interface CancelInput extends WriteOptions {
  /** The booking's confirmation code. */
  code: string;
  /** The customer's explicit yes to the cancellation terms. */
  user_confirmed: true;
}

export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'slot_unavailable'
  | 'party_size_unsupported'
  | 'hold_expired'
  | 'invalid_state'
  | 'user_confirmation_required'
  | 'customer_details_required'
  | 'payment_required'
  | 'payment_failed'
  | 'refund_failed'
  | 'cancellation_not_allowed'
  | 'reschedule_not_allowed'
  | 'idempotency_conflict'
  | 'operation_not_supported'
  | 'provider_error'
  | 'rate_limited';
