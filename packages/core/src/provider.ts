/**
 * The ONE interface a booking system implements to become bookable by agents over every protocol
 * OpenBooking supports.
 *
 * Division of responsibility:
 *  - The provider owns inventory and persistence: what is free, what is held, what is booked.
 *  - The BookingService (core) owns agent-safety: input validation, idempotency, hold TTL,
 *    explicit user confirmation, customer/deposit prerequisites, and cancellation-policy rules.
 *
 * Provider contract:
 *  - Every mutating method is ATOMIC: it either fully succeeds or throws without side effects.
 *  - `createHold` must reserve inventory exclusively until `expires_at`; two overlapping holds for
 *    the same capacity must never both succeed (throw `BookingError('slot_unavailable')`).
 *  - Expired holds must stop blocking inventory and should be reported with status `expired`.
 *  - Throw `BookingError` with a specific code for business failures; anything else is reported to
 *    agents as a retryable `provider_error`.
 */
import type {
  AvailabilityQuery,
  Booking,
  Customer,
  Money,
  Offering,
  Resource,
  Slot,
  Venue,
  VenueInfo,
} from './schemas';

export interface ProviderContext {
  /** The instant the engine considers "now" (from the injected Clock). */
  now: Date;
  /** Idempotency key of the originating call, for providers that also dedupe downstream. */
  idempotency_key?: string;
}

export interface CreateHoldRequest {
  slot_id: string;
  expires_at: Date;
  customer: Customer | null;
  notes: string | null;
}

export interface ConfirmHoldRequest {
  booking_id: string;
  customer: Customer;
  /** Present when the slot's deposit is due at confirmation. */
  payment_token: string | null;
}

export interface UpdateBookingRequest {
  booking_id: string;
  customer?: Customer;
  notes?: string | null;
}

export interface CancelBookingRequest {
  booking_id: string;
  reason: string | null;
  /** Fee computed by the engine from the cancellation policy (null for holds / free cancels). */
  fee: Money | null;
  /** Deposit refund computed by the engine. */
  refund: Money | null;
}

export interface ProviderInfo {
  /** Human/agent readable name of the booking system or business. */
  name: string;
  description?: string;
}

export interface BookingProvider {
  readonly info: ProviderInfo;

  /** All venues this provider can book. Most single-location businesses return one. */
  listVenues(): Promise<Venue[]>;

  /** Bookable slots matching the query. `venue_id` is always resolved by the engine. */
  searchAvailability(
    query: AvailabilityQuery & { venue_id: string },
    ctx: ProviderContext,
  ): Promise<Slot[]>;

  /** Atomically reserve the slot until `expires_at`. Returns a booking with status `held`. */
  createHold(req: CreateHoldRequest, ctx: ProviderContext): Promise<Booking>;

  /** Turn a non-expired hold into a confirmed booking. Must re-check expiry atomically. */
  confirmHold(req: ConfirmHoldRequest, ctx: ProviderContext): Promise<Booking>;

  getBooking(bookingId: string, ctx: ProviderContext): Promise<Booking | null>;

  /** Optional: update customer details/notes on a held or confirmed booking. */
  updateBooking?(req: UpdateBookingRequest, ctx: ProviderContext): Promise<Booking>;

  /** Release a hold, or cancel a confirmed booking applying the given fee/refund. */
  cancelBooking(req: CancelBookingRequest, ctx: ProviderContext): Promise<Booking>;

  /** Optional: services/offerings of a venue (Studio catalog, manual bookings). */
  listOfferings?(venueId: string, ctx: ProviderContext): Promise<Offering[]>;

  /** Optional: opening hours and booking rules, so agents can describe the venue and tell "closed" from "full". */
  getVenueInfo?(venueId: string, ctx: ProviderContext): Promise<VenueInfo>;

  /** Optional: bookable resources of a venue: staff, tables, rooms (Studio calendar columns). */
  listResources?(venueId: string, ctx: ProviderContext): Promise<Resource[]>;

  /**
   * Optional: list bookings (newest first) for dashboards such as OpenBooking Studio. Filter by
   * start time; the engine applies status filtering and expiry normalisation.
   */
  listBookings?(
    query: { from?: Date; to?: Date; limit?: number },
    ctx: ProviderContext,
  ): Promise<Booking[]>;
}
