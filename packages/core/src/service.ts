/**
 * BookingService: the protocol-agnostic, agent-safe booking engine. Every adapter (MCP, UCP, A2A)
 * calls this, never the provider directly, so every protocol gets the same guarantees:
 *
 *  - search → hold → confirm → (update) → cancel
 *  - holds expire (TTL) and always carry an explicit `expires_at`
 *  - every mutating call is idempotent on `idempotency_key`; retries never double-book
 *  - confirm requires `user_confirmed: true`; nothing is ever auto-confirmed
 *  - cancellation policy and deposit terms are part of every slot/hold before confirmation
 *  - all failures are `BookingError { code, message, suggested_next_action }`
 */
import type * as z from 'zod';
import { currentActor, type Actor } from './actor';
import { evaluateBookingCancellation } from './cancellation';
import { systemClock, type Clock } from './clock';
import { BookingError, fromZodError, isBookingError, type ErrorCode } from './errors';
import {
  IdempotencyGuard,
  MemoryIdempotencyStore,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  type IdempotencyStore,
} from './idempotency';
import type { BookingProvider, ProviderContext } from './provider';
import {
  AvailabilityQuerySchema,
  CancelInputSchema,
  ConfirmInputSchema,
  HoldInputSchema,
  UpdateInputSchema,
  type AvailabilityQueryInput,
  type Booking,
  type CancelInput,
  type ConfirmInput,
  type HoldInput,
  type Offering,
  type Resource,
  type Slot,
  type UpdateInput,
  type Venue,
} from './schemas';

export type Operation = 'search' | 'hold' | 'confirm' | 'get' | 'update' | 'cancel' | 'list';

/** Emitted after every operation; used for logging, metrics and the agent benchmark. */
export interface BookingEvent {
  operation: Operation;
  ok: boolean;
  at: string;
  booking_id?: string;
  status?: Booking['status'];
  error_code?: ErrorCode;
  /** True when the result was an idempotent replay (no new side effects). */
  replayed?: boolean;
  /** Who made the call (set when the request ran inside runAsActor). */
  actor?: Actor;
}

export interface ListBookingsQuery {
  status?: Booking['status'][];
  /** Only bookings starting at or after this instant. */
  from?: Date;
  /** Only bookings starting before this instant. */
  to?: Date;
  limit?: number;
}

export interface BookingServiceOptions {
  provider: BookingProvider;
  clock?: Clock;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlMs?: number;
  /** How long a hold reserves inventory. Default 600s (10 minutes). */
  holdTtlSeconds?: number;
  onEvent?: (event: BookingEvent) => void;
}

export interface SearchResult {
  venue: Venue;
  slots: Slot[];
}

export interface CancelResult {
  booking: Booking;
  /** True when the booking was already cancelled/expired and nothing changed. */
  already_inactive: boolean;
}

export const DEFAULT_HOLD_TTL_SECONDS = 600;

export class BookingService {
  readonly provider: BookingProvider;
  readonly clock: Clock;
  readonly holdTtlSeconds: number;
  readonly #guard: IdempotencyGuard;
  readonly #listeners = new Set<(e: BookingEvent) => void>();

  constructor(options: BookingServiceOptions) {
    this.provider = options.provider;
    this.clock = options.clock ?? systemClock;
    this.holdTtlSeconds = options.holdTtlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
    const now = () => this.clock.now().getTime();
    this.#guard = new IdempotencyGuard(
      options.idempotencyStore ?? new MemoryIdempotencyStore(now),
      options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
      now,
    );
    if (options.onEvent) this.#listeners.add(options.onEvent);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Services of a venue, or [] if the provider does not expose them. */
  async listOfferings(venueId?: string): Promise<Offering[]> {
    const venue = await this.resolveVenue(venueId);
    return (await this.provider.listOfferings?.(venue.id, this.#ctx())) ?? [];
  }

  /** Staff/tables/rooms of a venue, or [] if the provider does not expose them. */
  async listResources(venueId?: string): Promise<Resource[]> {
    const venue = await this.resolveVenue(venueId);
    return (await this.provider.listResources?.(venue.id, this.#ctx())) ?? [];
  }

  async listVenues(): Promise<Venue[]> {
    return this.provider.listVenues();
  }

  async resolveVenue(venueId?: string): Promise<Venue> {
    const venues = await this.provider.listVenues();
    if (venueId) {
      const venue = venues.find((v) => v.id === venueId);
      if (!venue) {
        throw new BookingError('not_found', `Unknown venue_id "${venueId}".`, {
          suggested_next_action: `Use one of: ${venues.map((v) => `${v.id} (${v.name})`).join(', ')}.`,
          details: { venue_ids: venues.map((v) => v.id) },
        });
      }
      return venue;
    }
    if (venues.length === 1) return venues[0]!;
    throw new BookingError(
      'validation_error',
      'venue_id is required: this server serves several venues.',
      {
        suggested_next_action: `Call again with venue_id set to one of: ${venues
          .map((v) => `${v.id} (${v.name})`)
          .join(', ')}.`,
        details: { venue_ids: venues.map((v) => v.id) },
      },
    );
  }

  async searchAvailability(input: AvailabilityQueryInput): Promise<SearchResult> {
    return this.#track('search', async () => {
      const query = parse(AvailabilityQuerySchema, input, 'search_availability');
      const venue = await this.resolveVenue(query.venue_id);
      const slots = await this.provider.searchAvailability(
        { ...query, venue_id: venue.id },
        this.#ctx(),
      );
      return { venue, slots: slots.slice(0, query.limit) };
    });
  }

  async getBooking(bookingId: string): Promise<Booking> {
    return this.#track('get', async () => this.#load(bookingId), bookingId);
  }

  /** Bookings for dashboards and staff tools. Requires the provider to implement listBookings. */
  async listBookings(query: ListBookingsQuery = {}): Promise<Booking[]> {
    return this.#track('list', async () => {
      if (!this.provider.listBookings) {
        throw new BookingError(
          'operation_not_supported',
          'This booking system does not support listing bookings.',
        );
      }
      const all = (await this.provider.listBookings(query, this.#ctx())).map((b) =>
        this.#normalize(b),
      );
      return all
        .filter((b) => !query.status || query.status.includes(b.status))
        .slice(0, query.limit ?? 500);
    });
  }

  /** Subscribe to every BookingEvent. Returns an unsubscribe function. */
  on(listener: (event: BookingEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: BookingEvent): void {
    const actor = currentActor();
    const full = actor ? { ...event, actor } : event;
    for (const l of this.#listeners) {
      try {
        l(full);
      } catch {
        // listeners must never break bookings
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Reserve a slot for `holdTtlSeconds`. Returns a booking in status `held` with `expires_at`. */
  async hold(input: HoldInput): Promise<Booking> {
    return this.#track('hold', async (meta) => {
      const { idempotency_key, ...req } = parse(HoldInputSchema, input, 'hold_slot');
      return this.#idempotent(meta, idempotency_key, 'hold', req, async (ctx) => {
        const expires_at = new Date(ctx.now.getTime() + this.holdTtlSeconds * 1000);
        const booking = await this.provider.createHold(
          {
            slot_id: req.slot_id,
            expires_at,
            customer: req.customer ?? null,
            notes: req.notes ?? null,
          },
          ctx,
        );
        return this.#normalize(booking);
      });
    });
  }

  /** Confirm a held booking. Requires `user_confirmed: true`. */
  async confirm(input: ConfirmInput): Promise<Booking> {
    return this.#track(
      'confirm',
      async (meta) => {
        const { idempotency_key, ...req } = parse(ConfirmInputSchema, input, 'confirm_booking');
        return this.#idempotent(meta, idempotency_key, 'confirm', req, async (ctx) => {
          const booking = await this.#load(req.booking_id);

          // Already confirmed (e.g. agent retried with a fresh key after a timeout): return as-is.
          if (booking.status === 'confirmed') return booking;
          if (booking.status === 'cancelled') {
            throw new BookingError(
              'invalid_state',
              `Booking ${booking.booking_id} is cancelled and cannot be confirmed.`,
              {
                suggested_next_action:
                  'Call search_availability and hold_slot to start a new booking.',
              },
            );
          }
          if (booking.status === 'expired') throw holdExpired(booking);

          if (req.user_confirmed !== true) {
            throw new BookingError(
              'user_confirmation_required',
              'confirm_booking requires explicit user approval (user_confirmed=true). Never set it without asking the user.',
              { details: { summary: summarize(booking) } },
            );
          }

          const customer = req.customer ?? booking.customer;
          if (!customer) {
            throw new BookingError(
              'customer_details_required',
              'A customer name plus email or phone is required to confirm.',
            );
          }

          const deposit = booking.slot.deposit;
          if (deposit?.due === 'at_confirmation' && !req.payment_token) {
            throw new BookingError(
              'payment_required',
              `A deposit of ${formatMoney(deposit.amount)} is due at confirmation.`,
              { details: { deposit } },
            );
          }

          const confirmed = await this.provider.confirmHold(
            { booking_id: booking.booking_id, customer, payment_token: req.payment_token ?? null },
            ctx,
          );
          return this.#normalize(confirmed);
        });
      },
      bookingIdOf(input),
    );
  }

  /** Update customer details and/or notes on a held or confirmed booking. */
  async update(input: UpdateInput): Promise<Booking> {
    return this.#track(
      'update',
      async (meta) => {
        const { idempotency_key, ...req } = parse(UpdateInputSchema, input, 'update_booking');
        return this.#idempotent(meta, idempotency_key, 'update', req, async (ctx) => {
          if (!this.provider.updateBooking) {
            throw new BookingError(
              'operation_not_supported',
              'This booking system does not support updates.',
            );
          }
          const booking = await this.#load(req.booking_id);
          if (booking.status === 'expired') throw holdExpired(booking);
          if (booking.status === 'cancelled') {
            throw new BookingError('invalid_state', `Booking ${booking.booking_id} is cancelled.`);
          }
          const updated = await this.provider.updateBooking(
            {
              booking_id: booking.booking_id,
              ...(req.customer ? { customer: req.customer } : {}),
              ...(req.notes !== undefined ? { notes: req.notes } : {}),
            },
            ctx,
          );
          return this.#normalize(updated);
        });
      },
      bookingIdOf(input),
    );
  }

  /**
   * Release a hold (no consent needed) or cancel a confirmed booking (requires
   * `user_confirmed: true`; applies the cancellation policy). Cancelling something already
   * cancelled/expired is a no-op that returns the current state.
   */
  async cancel(input: CancelInput): Promise<CancelResult> {
    return this.#track(
      'cancel',
      async (meta) => {
        const { idempotency_key, ...req } = parse(CancelInputSchema, input, 'cancel_booking');
        return this.#idempotent(meta, idempotency_key, 'cancel', req, async (ctx) => {
          const booking = await this.#load(req.booking_id);
          if (booking.status === 'cancelled' || booking.status === 'expired') {
            return { booking, already_inactive: true };
          }

          if (booking.status === 'held') {
            const released = await this.provider.cancelBooking(
              {
                booking_id: booking.booking_id,
                reason: req.reason ?? null,
                fee: null,
                refund: null,
              },
              ctx,
            );
            return { booking: this.#normalize(released), already_inactive: false };
          }

          const outcome = evaluateBookingCancellation(booking, ctx.now);
          if (!outcome.allowed) {
            throw new BookingError(
              'cancellation_not_allowed',
              'The booking has already started and can no longer be cancelled online.',
              { details: { cancellation_policy: booking.slot.cancellation_policy } },
            );
          }
          if (req.user_confirmed !== true) {
            throw new BookingError(
              'user_confirmation_required',
              outcome.free
                ? 'Cancelling a confirmed booking requires explicit user approval (user_confirmed=true). Cancellation is currently free.'
                : `Cancelling now costs ${outcome.fee ? formatMoney(outcome.fee) : 'a fee'}. Explicit user approval (user_confirmed=true) is required.`,
              {
                suggested_next_action:
                  'Tell the user the cancellation terms (fee and refund), ask for explicit approval, then call again with user_confirmed=true.',
                details: { fee: outcome.fee, refund: outcome.refund, free: outcome.free },
              },
            );
          }
          const cancelled = await this.provider.cancelBooking(
            {
              booking_id: booking.booking_id,
              reason: req.reason ?? null,
              fee: outcome.fee,
              refund: outcome.refund,
            },
            ctx,
          );
          return { booking: this.#normalize(cancelled), already_inactive: false };
        });
      },
      bookingIdOf(input),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #ctx(idempotency_key?: string): ProviderContext {
    return { now: this.clock.now(), ...(idempotency_key ? { idempotency_key } : {}) };
  }

  async #load(bookingId: string): Promise<Booking> {
    const booking = await this.provider.getBooking(bookingId, this.#ctx());
    if (!booking) throw new BookingError('not_found', `No booking with id "${bookingId}".`);
    return this.#normalize(booking);
  }

  /** Holds past `expires_at` are presented as `expired` even if the provider has not swept them. */
  #normalize(booking: Booking): Booking {
    if (
      booking.status === 'held' &&
      booking.expires_at &&
      new Date(booking.expires_at).getTime() <= this.clock.now().getTime()
    ) {
      return { ...booking, status: 'expired' };
    }
    return booking;
  }

  async #idempotent<T extends Booking | CancelResult>(
    meta: CallMeta,
    key: string,
    operation: Operation,
    request: unknown,
    fn: (ctx: ProviderContext) => Promise<T>,
  ): Promise<T> {
    const { value, replayed } = await this.#guard.run(key, operation, request, () =>
      fn(this.#ctx(key)),
    );
    meta.replayed = replayed;
    if (!replayed) return value;
    // On replay, return the *current* state of the same booking (it may have expired or been
    // confirmed since), never a stale snapshot, and never a second side effect.
    const id = 'booking' in value ? value.booking.booking_id : value.booking_id;
    const current = await this.provider.getBooking(id, this.#ctx());
    if (!current) return value;
    const fresh = this.#normalize(current);
    return ('booking' in value ? { ...value, booking: fresh } : fresh) as T;
  }

  async #track<T>(
    operation: Operation,
    fn: (meta: CallMeta) => Promise<T>,
    bookingIdHint?: unknown,
  ): Promise<T> {
    const meta: CallMeta = { replayed: false };
    const hint = typeof bookingIdHint === 'string' ? { booking_id: bookingIdHint } : {};
    try {
      const result = await fn(meta);
      const booking = bookingOf(result);
      this.#emit({
        operation,
        ok: true,
        at: this.clock.now().toISOString(),
        ...(booking ? { booking_id: booking.booking_id, status: booking.status } : hint),
        ...(meta.replayed ? { replayed: true } : {}),
      });
      return result;
    } catch (e) {
      const error = isBookingError(e)
        ? e
        : new BookingError('provider_error', 'Unexpected error in the booking system.', {
            cause: e,
          });
      this.#emit({
        operation,
        ok: false,
        at: this.clock.now().toISOString(),
        ...hint,
        error_code: error.code,
      });
      throw error;
    }
  }
}

interface CallMeta {
  replayed: boolean;
}

function parse<S extends z.ZodType>(schema: S, input: unknown, context: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw fromZodError(result.error, context);
  return result.data;
}

function bookingOf(result: unknown): Booking | undefined {
  if (result && typeof result === 'object') {
    if ('booking_id' in result) return result as Booking;
    if ('booking' in result) return (result as CancelResult).booking;
  }
  return undefined;
}

function holdExpired(booking: Booking): BookingError {
  return new BookingError(
    'hold_expired',
    `The hold on booking ${booking.booking_id} expired at ${booking.expires_at}.`,
    {
      details: { expired_at: booking.expires_at },
    },
  );
}

export function formatMoney(m: { amount: number; currency: string }): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}

/** Compact, user-presentable summary of what is about to be (or was) booked. */
export function summarize(booking: Booking) {
  return {
    booking_id: booking.booking_id,
    status: booking.status,
    start: booking.slot.start,
    end: booking.slot.end,
    party_size: booking.slot.party_size.total,
    offering: booking.slot.offering.name,
    price: booking.slot.price,
    deposit: booking.slot.deposit,
    cancellation_policy: booking.slot.cancellation_policy,
    expires_at: booking.expires_at,
  };
}

function bookingIdOf(input: unknown): unknown {
  return input && typeof input === 'object'
    ? (input as { booking_id?: unknown }).booking_id
    : undefined;
}
