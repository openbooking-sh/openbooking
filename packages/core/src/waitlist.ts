/**
 * Waitlist: a customer asks to be told when a full time opens up, and when it does the freed
 * slot is held for them and they are offered it.
 *
 * It sits on top of {@link BookingService} and never touches the provider itself, so it has the
 * same guarantees for every booking system:
 *
 *  - joining is only allowed when nothing is bookable now (otherwise: book directly);
 *  - when a booking is cancelled or a hold lapses, the FIRST waiting entry that fits gets an
 *    offer: a real hold on a freed slot, for a short window;
 *  - an entry holds at most one slot, and a slot goes to one entry: the claim is an atomic
 *    compare-and-set in the {@link WaitlistStore}, and the hold itself is the provider's atomic
 *    write, so two instances racing for the same capacity never produce two offers;
 *  - accepting is the normal `confirm` with `user_confirmed: true`. Nothing is auto-confirmed;
 *  - an offer that lapses (the hold expires) or is declined (the hold is released) passes on to
 *    the next entry.
 *
 * Staff-side use (a restaurant's walk-in list) can reuse this: `join` is the customer-facing
 * entry point, `store` is the data, and {@link Waitlist.offerFreed} hands freed capacity to the
 * queue from anywhere.
 */
import * as z from 'zod';
import { currentActor, runAsActor } from './actor';
import { BookingError, fromZodError, isBookingError } from './errors';
import {
  IdempotencyGuard,
  MemoryIdempotencyStore,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  type IdempotencyStore,
} from './idempotency';
import {
  CustomerSchema,
  DateSchema,
  DateTimeSchema,
  IdempotencyKeySchema,
  LocalTimeSchema,
  type Booking,
  type Customer,
} from './schemas';
import type { BookingEvent, BookingService } from './service';
import * as time from './time';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * `waiting` → `offered` (a hold is placed) → `accepted` (the customer confirmed it), or
 * `declined` (they released it), or `expired` (the hold lapsed). `waiting` entries also end as
 * `expired` (the day passed) or `cancelled` (the customer left).
 */
export const WaitlistStatusSchema = z.enum([
  'waiting',
  'offered',
  'accepted',
  'declined',
  'expired',
  'cancelled',
]);
export type WaitlistStatus = z.infer<typeof WaitlistStatusSchema>;

/** Statuses an entry never leaves; they are kept for a while for the record, then purged. */
export const FINAL_WAITLIST_STATUSES: readonly WaitlistStatus[] = [
  'accepted',
  'declined',
  'expired',
  'cancelled',
];

/**
 * Evidence that the customer agreed to be contacted about an offer and to have the slot held for
 * them. Like booking consent evidence it names nobody; the caller and time are what matter.
 */
export const WaitlistConsentSchema = z.object({
  user_confirmed: z.literal(true),
  at: DateTimeSchema,
  /** The agent or channel that relayed the consent, e.g. "Claude". */
  agent: z.string().nullable(),
  /** What the customer agreed to. */
  purpose: z.literal('offer_notification_and_hold'),
});
export type WaitlistConsent = z.infer<typeof WaitlistConsentSchema>;

export const WaitlistOfferSchema = z.object({
  /** The hold on the offered slot. null only for the instant between claiming and holding. */
  booking_id: z.string().nullable(),
  offered_at: DateTimeSchema,
  /** When the hold lapses and the offer passes on. */
  expires_at: DateTimeSchema,
});
export type WaitlistOffer = z.infer<typeof WaitlistOfferSchema>;

export const WaitlistEntrySchema = z.object({
  waitlist_id: z.string(),
  venue_id: z.string(),
  /** null = any service. */
  offering_id: z.string().nullable(),
  date: DateSchema,
  /** Window for the start time, venue local `HH:MM` (inclusive). null = the whole day. */
  time_from: LocalTimeSchema.nullable(),
  time_to: LocalTimeSchema.nullable(),
  party_size: z.number().int().min(1).max(100),
  customer: CustomerSchema,
  status: WaitlistStatusSchema,
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  /** A waiting entry lapses at the end of the requested day: there is nothing left to wait for. */
  expires_at: DateTimeSchema,
  consent: WaitlistConsentSchema,
  offer: WaitlistOfferSchema.nullable(),
});
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;

export const JoinWaitlistInputSchema = z
  .object({
    venue_id: z.string().min(1).max(200).optional(),
    date: DateSchema,
    party_size: z.number().int().min(1).max(100),
    offering_id: z.string().min(1).max(200).optional(),
    time_from: LocalTimeSchema.optional(),
    time_to: LocalTimeSchema.optional(),
    /** Who to contact. Offers are emailed, so an email address is what makes joining useful. */
    customer: CustomerSchema,
    /** Required (true): the customer agreed to be contacted and to have a slot held for them. */
    user_confirmed: z.boolean(),
    idempotency_key: IdempotencyKeySchema,
  })
  .refine((q) => !q.time_from || !q.time_to || q.time_from <= q.time_to, {
    message: 'time_from must be <= time_to',
    path: ['time_from'],
  });
export type JoinWaitlistInput = z.input<typeof JoinWaitlistInputSchema>;

export const LeaveWaitlistInputSchema = z.object({
  waitlist_id: z.string().min(1).max(200),
  idempotency_key: IdempotencyKeySchema,
});
export type LeaveWaitlistInput = z.input<typeof LeaveWaitlistInputSchema>;

/** Who a data request is about: an email address, a phone number, or both. */
export interface WaitlistCustomerMatch {
  email?: string | undefined;
  phone?: string | undefined;
}

const MIN_PHONE_DIGITS = 6;
const digits = (s: string) => s.replace(/\D/g, '');

/** Email is compared case-insensitively; phone numbers by their digits. Same rule as bookings. */
export function matchesWaitlistCustomer(customer: Customer, match: WaitlistCustomerMatch): boolean {
  const email = match.email?.trim().toLowerCase();
  const phone = match.phone ? digits(match.phone) : '';
  return (
    (!!email && customer.email?.toLowerCase() === email) ||
    (phone.length >= MIN_PHONE_DIGITS &&
      !!customer.phone_number &&
      digits(customer.phone_number) === phone)
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface WaitlistQuery {
  venue_id?: string;
  /** Requested date `YYYY-MM-DD`. */
  date?: string;
  status?: WaitlistStatus[];
  limit?: number;
}

/**
 * Where entries live. Every method that changes an entry is an atomic compare-and-set and
 * resolves to the updated entry, or to `undefined` when the entry was not in the expected state
 * (someone else got there first). That is what lets several server instances share one queue.
 * The memory store below and the Postgres store run the same contract tests.
 */
export interface WaitlistStore {
  insert(entry: WaitlistEntry): Promise<void>;
  get(waitlistId: string): Promise<WaitlistEntry | undefined>;
  /** The entry whose offer is this hold. */
  findByOffer(bookingId: string): Promise<WaitlistEntry | undefined>;
  /** Oldest first (the order people joined), whatever the filter. */
  list(query?: WaitlistQuery): Promise<WaitlistEntry[]>;
  /**
   * `waiting` → `offered` with an offer that has no hold yet. Only one caller can win this for an
   * entry; everyone else gets `undefined`.
   */
  claim(
    waitlistId: string,
    offer: { offered_at: string; expires_at: string },
    at: string,
  ): Promise<WaitlistEntry | undefined>;
  /** Record the hold on an `offered` entry that has none yet. */
  attachOffer(
    waitlistId: string,
    offer: { booking_id: string; expires_at: string },
    at: string,
  ): Promise<WaitlistEntry | undefined>;
  /** Give back a claim that never got a hold: `offered` without a hold → `waiting`, same place. */
  release(waitlistId: string, at: string): Promise<WaitlistEntry | undefined>;
  /** Move to `to` only if the entry is currently in one of `from`. */
  transition(
    waitlistId: string,
    from: readonly WaitlistStatus[],
    to: WaitlistStatus,
    at: string,
  ): Promise<WaitlistEntry | undefined>;
  /** Entries carrying this email or phone number (data export). `venueId` limits to one business. */
  forCustomer(match: WaitlistCustomerMatch, venueId?: string): Promise<WaitlistEntry[]>;
  /** Delete them. Resolves how many went. */
  eraseCustomer(match: WaitlistCustomerMatch, venueId?: string): Promise<number>;
  /** Delete every entry of a venue (a hosted business closing its account). */
  deleteVenue(venueId: string): Promise<number>;
  /** Delete entries in a final status last changed before `before`. Resolves how many went. */
  purge(before: string): Promise<number>;
}

/** In memory, for one process. Fine for a single server; use the Postgres store for several. */
export class MemoryWaitlistStore implements WaitlistStore {
  // Map keeps insertion order, which is the order people joined.
  readonly #entries = new Map<string, WaitlistEntry>();

  async insert(entry: WaitlistEntry): Promise<void> {
    if (this.#entries.has(entry.waitlist_id)) {
      throw new Error(`Waitlist entry ${entry.waitlist_id} already exists.`);
    }
    this.#entries.set(entry.waitlist_id, structuredClone(entry));
  }

  async get(id: string) {
    return clone(this.#entries.get(id));
  }

  async findByOffer(bookingId: string) {
    for (const e of this.#entries.values()) {
      if (e.offer?.booking_id === bookingId) return structuredClone(e);
    }
    return undefined;
  }

  async list(query: WaitlistQuery = {}) {
    const out: WaitlistEntry[] = [];
    for (const e of this.#entries.values()) {
      if (query.venue_id && e.venue_id !== query.venue_id) continue;
      if (query.date && e.date !== query.date) continue;
      if (query.status && !query.status.includes(e.status)) continue;
      out.push(structuredClone(e));
      if (query.limit && out.length >= query.limit) break;
    }
    return out;
  }

  // The methods below read and write without awaiting in between, so each is atomic in this process.

  async claim(id: string, offer: { offered_at: string; expires_at: string }, at: string) {
    const e = this.#entries.get(id);
    if (!e || e.status !== 'waiting') return undefined;
    Object.assign(e, { status: 'offered', updated_at: at, offer: { booking_id: null, ...offer } });
    return structuredClone(e);
  }

  async attachOffer(id: string, offer: { booking_id: string; expires_at: string }, at: string) {
    const e = this.#entries.get(id);
    if (!e || e.status !== 'offered' || !e.offer || e.offer.booking_id !== null) return undefined;
    e.offer = { ...e.offer, ...offer };
    e.updated_at = at;
    return structuredClone(e);
  }

  async release(id: string, at: string) {
    const e = this.#entries.get(id);
    if (!e || e.status !== 'offered' || !e.offer || e.offer.booking_id !== null) return undefined;
    Object.assign(e, { status: 'waiting', updated_at: at, offer: null });
    return structuredClone(e);
  }

  async transition(id: string, from: readonly WaitlistStatus[], to: WaitlistStatus, at: string) {
    const e = this.#entries.get(id);
    if (!e || !from.includes(e.status)) return undefined;
    Object.assign(e, { status: to, updated_at: at });
    return structuredClone(e);
  }

  async forCustomer(match: WaitlistCustomerMatch, venueId?: string) {
    return [...this.#entries.values()]
      .filter(
        (e) => (!venueId || e.venue_id === venueId) && matchesWaitlistCustomer(e.customer, match),
      )
      .map((e) => structuredClone(e));
  }

  async eraseCustomer(match: WaitlistCustomerMatch, venueId?: string) {
    return this.#delete(
      (e) => (!venueId || e.venue_id === venueId) && matchesWaitlistCustomer(e.customer, match),
    );
  }

  async deleteVenue(venueId: string) {
    return this.#delete((e) => e.venue_id === venueId);
  }

  async purge(before: string) {
    const cutoff = Date.parse(before);
    return this.#delete(
      (e) => FINAL_WAITLIST_STATUSES.includes(e.status) && Date.parse(e.updated_at) < cutoff,
    );
  }

  #delete(test: (e: WaitlistEntry) => boolean): number {
    let n = 0;
    for (const [id, e] of this.#entries) {
      if (test(e)) {
        this.#entries.delete(id);
        n++;
      }
    }
    return n;
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

export type WaitlistEventType =
  /** Someone joined. */
  | 'joined'
  /** A slot is held for the entry and the customer should be told. Carries the hold. */
  | 'offered'
  /** The customer confirmed the held slot. */
  | 'accepted'
  /** The customer released the held slot (or left the list). */
  | 'declined'
  /** The offer lapsed unanswered: the hold expired. */
  | 'lapsed'
  /** The customer left before any offer. */
  | 'left';

/** Emitted for every change to an entry. Carries the customer: send it to no logs or analytics. */
export interface WaitlistEvent {
  type: WaitlistEventType;
  at: string;
  entry: WaitlistEntry;
  /** The held (or confirmed) slot, for `offered`, `accepted`, `declined` and `lapsed`. */
  booking?: Booking;
}

export interface WaitlistOptions {
  service: BookingService;
  /** Default: in memory. With several instances pass a shared store, e.g. the Postgres one. */
  store?: WaitlistStore;
  /** For idempotent joins and leaves. Default: in memory; share it like the service's own. */
  idempotencyStore?: IdempotencyStore;
  /** How long an offered slot is held before it passes to the next entry. Default 900 (15 min). */
  offerTtlSeconds?: number;
  /** How long finished entries are kept before they are deleted. Default 30 days. */
  retentionDays?: number;
  /** Open entries one email address or phone number may have at a business. Default 5. */
  maxActivePerCustomer?: number;
  onEvent?: (event: WaitlistEvent) => void;
  /** Called when a background offer fails. Default: console.error without the entry. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_OFFER_TTL_SECONDS = 900;
export const DEFAULT_WAITLIST_RETENTION_DAYS = 30;
export const DEFAULT_MAX_ACTIVE_PER_CUSTOMER = 5;
/** Most waiting entries looked at for one freed slot; bounds the work a cancellation can cause. */
const MAX_CANDIDATES = 50;
/** Slots tried for one entry before giving up on this freed capacity. */
const SLOTS_PER_ENTRY = 3;

const WAITLIST_ACTOR = { protocol: 'api', agent: 'Waitlist' } as const;

export class Waitlist {
  readonly service: BookingService;
  readonly store: WaitlistStore;
  readonly offerTtlSeconds: number;
  readonly #guard: IdempotencyGuard;
  readonly #listeners = new Set<(e: WaitlistEvent) => void>();
  readonly #retentionMs: number;
  readonly #maxActive: number;
  readonly #onError: (error: unknown) => void;
  readonly #detach: () => void;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WaitlistOptions) {
    this.service = options.service;
    this.store = options.store ?? new MemoryWaitlistStore();
    this.offerTtlSeconds = options.offerTtlSeconds ?? DEFAULT_OFFER_TTL_SECONDS;
    this.#retentionMs = (options.retentionDays ?? DEFAULT_WAITLIST_RETENTION_DAYS) * 86_400_000;
    this.#maxActive = options.maxActivePerCustomer ?? DEFAULT_MAX_ACTIVE_PER_CUSTOMER;
    const now = () => this.service.clock.now().getTime();
    this.#guard = new IdempotencyGuard(
      options.idempotencyStore ?? new MemoryIdempotencyStore(now),
      DEFAULT_IDEMPOTENCY_TTL_MS,
      now,
    );
    if (options.onEvent) this.#listeners.add(options.onEvent);
    this.#onError =
      options.onError ??
      ((e) => console.error('[openbooking] waitlist offer failed', isBookingError(e) ? e.code : e));
    this.#detach = this.service.on((event) => {
      this.#tail = this.#tail.then(() => this.#handle(event).catch(this.#onError));
    });
  }

  /** Subscribe to every WaitlistEvent. Returns an unsubscribe function. */
  on(listener: (event: WaitlistEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stop reacting to booking events. */
  close(): void {
    this.#detach();
  }

  /** Resolves once every offer queued by a booking event so far is done (or failed). */
  idle(): Promise<void> {
    return this.#tail;
  }

  #emit(type: WaitlistEventType, entry: WaitlistEntry, booking?: Booking): void {
    const event: WaitlistEvent = {
      type,
      at: this.service.clock.now().toISOString(),
      entry,
      ...(booking ? { booking } : {}),
    };
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch {
        // listeners must never break the waitlist
      }
    }
  }

  // -------------------------------------------------------------------------
  // Customer-facing
  // -------------------------------------------------------------------------

  /**
   * Join the waitlist for a day (and optionally a service and time window) that is full. Refused
   * when something is bookable, so nobody queues for a table they could book right now.
   */
  async join(input: JoinWaitlistInput): Promise<WaitlistEntry> {
    const parsed = JoinWaitlistInputSchema.safeParse(input);
    if (!parsed.success) throw fromZodError(parsed.error, 'join_waitlist');
    const { idempotency_key, ...req } = parsed.data;
    const { value, replayed } = await this.#guard.run(
      `waitlist:${idempotency_key}`,
      'join',
      req,
      () => this.#join(req),
    );
    if (!replayed) return value;
    // The entry may have moved on since (offered, say): show where it is now.
    return (await this.store.get(value.waitlist_id)) ?? value;
  }

  async #join(req: Omit<z.output<typeof JoinWaitlistInputSchema>, 'idempotency_key'>) {
    if (req.user_confirmed !== true) {
      throw new BookingError(
        'user_confirmation_required',
        'Joining the waitlist needs the customer to agree (user_confirmed=true): they will be contacted if a time opens up, and a slot will be held for them.',
        {
          suggested_next_action:
            'Tell the user: if a time opens up we will hold it for them for a short while and email them. Ask whether they want that, then call again with user_confirmed=true.',
        },
      );
    }
    const now = this.service.clock.now();
    const venue = await this.service.resolveVenue(req.venue_id);
    if (req.date < time.localDate(now, venue.timezone)) {
      throw new BookingError('validation_error', `${req.date} is in the past.`);
    }
    if (req.offering_id) {
      const offerings = await this.service.listOfferings(venue.id);
      if (offerings.length && !offerings.some((o) => o.id === req.offering_id)) {
        throw new BookingError('not_found', `Unknown offering_id "${req.offering_id}".`, {
          suggested_next_action: 'Call get_business_info to see the services, then try again.',
        });
      }
    }

    const query = {
      venue_id: venue.id,
      date: req.date,
      party_size: { total: req.party_size },
      ...(req.offering_id ? { offering_id: req.offering_id } : {}),
      ...(req.time_from ? { time_from: req.time_from } : {}),
      ...(req.time_to ? { time_to: req.time_to } : {}),
    };
    const { slots } = await this.service.searchAvailability({ ...query, limit: 5 });
    if (slots.length) {
      throw new BookingError(
        'invalid_state',
        'Something is bookable for this request, so there is nothing to wait for.',
        {
          suggested_next_action:
            'Do not join the waitlist. Offer these times and book one with hold_slot.',
          details: {
            slots: slots.map((s) => ({ slot_id: s.slot_id, start: s.start, end: s.end })),
          },
        },
      );
    }
    const info = await this.service.getVenueInfo(venue.id).catch(() => null);
    if (info) {
      const weekday = WEEKDAY_KEYS[time.weekdayOfDate(req.date)]!;
      if (info.closed_dates.includes(req.date) || !(info.opening_hours[weekday] ?? []).length) {
        throw new BookingError('validation_error', `${venue.name} is closed on ${req.date}.`, {
          suggested_next_action:
            'A waitlist cannot help on a closed day. Call get_business_info for opening hours and suggest another day.',
        });
      }
    }

    const open = (await this.store.forCustomer(req.customer, venue.id)).filter(
      (e) => e.status === 'waiting' || e.status === 'offered',
    );
    if (open.length >= this.#maxActive) {
      throw new BookingError(
        'rate_limited',
        `This contact is already on ${open.length} waitlists here.`,
        {
          suggested_next_action:
            'Leave one of the waitlists with leave_waitlist, or wait for an offer, before joining another.',
        },
      );
    }

    const at = now.toISOString();
    const entry: WaitlistEntry = {
      waitlist_id: `wl_${crypto.randomUUID()}`,
      venue_id: venue.id,
      offering_id: req.offering_id ?? null,
      date: req.date,
      time_from: req.time_from ?? null,
      time_to: req.time_to ?? null,
      party_size: req.party_size,
      customer: req.customer,
      status: 'waiting',
      created_at: at,
      updated_at: at,
      // Midnight at the end of the requested day, venue time.
      expires_at: time.formatInZone(
        time.zonedToInstant(time.addDays(req.date, 1), '00:00', venue.timezone),
        venue.timezone,
      ),
      consent: {
        user_confirmed: true,
        at,
        agent: currentActor()?.agent ?? null,
        purpose: 'offer_notification_and_hold',
      },
      offer: null,
    };
    await this.store.insert(entry);
    this.#emit('joined', entry);
    return entry;
  }

  /** The entry as it is now. */
  async get(waitlistId: string): Promise<WaitlistEntry> {
    const entry = await this.store.get(waitlistId);
    if (!entry) throw notFound(waitlistId);
    return entry;
  }

  /**
   * Leave the list. If a slot is held for the entry it is released, which passes it to the next
   * customer. Leaving after accepting (the booking is confirmed) changes nothing: cancel the
   * booking instead.
   */
  async leave(input: LeaveWaitlistInput): Promise<WaitlistEntry> {
    const parsed = LeaveWaitlistInputSchema.safeParse(input);
    if (!parsed.success) throw fromZodError(parsed.error, 'leave_waitlist');
    const { idempotency_key, waitlist_id } = parsed.data;
    const { value } = await this.#guard.run(
      `waitlist:${idempotency_key}`,
      'leave',
      { waitlist_id },
      () => this.#leave(waitlist_id),
    );
    return (await this.store.get(value.waitlist_id)) ?? value;
  }

  async #leave(waitlistId: string): Promise<WaitlistEntry> {
    const now = () => this.service.clock.now().toISOString();
    let current = await this.get(waitlistId);
    if (current.status === 'waiting') {
      const left = await this.store.transition(waitlistId, ['waiting'], 'cancelled', now());
      if (left) {
        this.#emit('left', left);
        return left;
      }
      current = await this.get(waitlistId); // an offer landed first
    }
    if (current.status !== 'offered') return current; // already over
    const hold = current.offer?.booking_id;
    if (hold) {
      // Releasing a hold needs no consent. If it was confirmed in the meantime this refuses
      // (a confirmed booking needs user_confirmed to cancel), which is what we want.
      await runAsActor(WAITLIST_ACTOR, () =>
        this.service.cancel({ booking_id: hold, idempotency_key: `waitlist-leave:${waitlistId}` }),
      );
    }
    await this.#settleOffer(current, 'declined');
    return this.get(waitlistId);
  }

  // -------------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------------

  /**
   * Hand freed capacity (a cancelled booking, a lapsed hold) to the queue: the first waiting
   * entry that has something bookable gets a hold and an `offered` event. Safe to call from
   * every instance at once and more than once for the same booking. Resolves the entry that got
   * an offer, if any. Happens by itself on booking events; call it to feed the queue by hand.
   */
  async offerFreed(freed: Booking): Promise<WaitlistEntry | undefined> {
    const now = this.service.clock.now();
    const venue = await this.service.resolveVenue(freed.venue_id);
    const date = time.localDate(new Date(freed.slot.start), venue.timezone);
    const waiting = await this.store.list({
      venue_id: freed.venue_id,
      date,
      status: ['waiting'],
      limit: MAX_CANDIDATES,
    });
    for (const entry of waiting) {
      if (Date.parse(entry.expires_at) <= now.getTime()) {
        await this.store.transition(entry.waitlist_id, ['waiting'], 'expired', now.toISOString());
        continue;
      }
      if (entry.offering_id && entry.offering_id !== freed.slot.offering.id) continue;
      const offered = await runAsActor(WAITLIST_ACTOR, () => this.#offerTo(entry));
      if (offered) return offered;
    }
    return undefined;
  }

  async #offerTo(entry: WaitlistEntry): Promise<WaitlistEntry | undefined> {
    const clock = this.service.clock;
    // Look before claiming: most freed slots do not suit most entries, and a claim that is
    // given back costs two writes.
    const { slots } = await this.service.searchAvailability({
      venue_id: entry.venue_id,
      date: entry.date,
      party_size: { total: entry.party_size },
      ...(entry.offering_id ? { offering_id: entry.offering_id } : {}),
      ...(entry.time_from ? { time_from: entry.time_from } : {}),
      ...(entry.time_to ? { time_to: entry.time_to } : {}),
      limit: SLOTS_PER_ENTRY,
    });
    if (!slots.length) return undefined;

    const offeredAt = clock.now();
    const claimed = await this.store.claim(
      entry.waitlist_id,
      {
        offered_at: offeredAt.toISOString(),
        expires_at: new Date(offeredAt.getTime() + this.offerTtlSeconds * 1000).toISOString(),
      },
      offeredAt.toISOString(),
    );
    // Someone else (another instance, a customer leaving) got there first: this entry is theirs.
    if (!claimed) return undefined;

    let hold: Booking | undefined;
    try {
      for (const slot of slots) {
        try {
          hold = await this.service.hold(
            {
              slot_id: slot.slot_id,
              // One successful hold per entry, ever: a retry of this very offer replays it.
              idempotency_key: `waitlist-offer:${entry.waitlist_id}`,
              customer: entry.customer,
              notes: 'Offered from the waitlist.',
            },
            { ttlSeconds: this.offerTtlSeconds },
          );
          break;
        } catch (e) {
          // The provider is the arbiter of who gets a slot: losing the race is normal.
          if (isBookingError(e) && e.code === 'slot_unavailable') continue;
          throw e;
        }
      }
    } catch (e) {
      await this.store.release(entry.waitlist_id, clock.now().toISOString());
      throw e;
    }
    if (!hold) {
      await this.store.release(entry.waitlist_id, clock.now().toISOString());
      return undefined;
    }

    const attached = await this.store.attachOffer(
      entry.waitlist_id,
      { booking_id: hold.booking_id, expires_at: hold.expires_at ?? claimed.offer!.expires_at },
      clock.now().toISOString(),
    );
    if (!attached) {
      // The entry changed while we held (a customer erased their data, say): don't strand a hold.
      await this.service
        .cancel({
          booking_id: hold.booking_id,
          idempotency_key: `waitlist-undo:${entry.waitlist_id}`,
        })
        .catch(this.#onError);
      return undefined;
    }
    this.#emit('offered', attached, hold);
    return attached;
  }

  /** An offer ended without a confirmation: record it and tell listeners. */
  async #settleOffer(entry: WaitlistEntry, to: 'declined' | 'expired'): Promise<void> {
    const changed = await this.store.transition(
      entry.waitlist_id,
      ['offered'],
      to,
      this.service.clock.now().toISOString(),
    );
    if (changed) this.#emit(to === 'expired' ? 'lapsed' : 'declined', changed);
  }

  async #handle(event: BookingEvent): Promise<void> {
    const booking = event.booking;
    if (!event.ok || event.replayed || !booking) return;
    switch (event.operation) {
      case 'confirm': {
        if (booking.status !== 'confirmed') return;
        const entry = await this.store.findByOffer(booking.booking_id);
        if (!entry) return;
        const accepted = await this.store.transition(
          entry.waitlist_id,
          ['offered'],
          'accepted',
          this.service.clock.now().toISOString(),
        );
        if (accepted) this.#emit('accepted', accepted, booking);
        return;
      }
      case 'cancel':
      case 'expire': {
        const ended = event.operation === 'cancel' ? 'cancelled' : 'expired';
        if (booking.status !== ended || event.unchanged) return;
        const entry = await this.store.findByOffer(booking.booking_id);
        if (entry) {
          await this.#settleOffer(entry, event.operation === 'cancel' ? 'declined' : 'expired');
        }
        // The slot is free again: the next in line gets it.
        await this.offerFreed(booking);
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Upkeep and customer data
  // -------------------------------------------------------------------------

  /**
   * Housekeeping, for a timer or cron (safe from every instance at once): announce holds that
   * lapsed so their slots are offered on, retire entries whose day has passed or whose offer
   * lapsed, and delete finished entries after the retention window. Resolves how many entries
   * it deleted. Entries go stale without it, though offers still pass on whenever a lapsed hold
   * is noticed (any read of the booking, or `service.sweepExpired`).
   */
  async sweep(): Promise<number> {
    await this.service.sweepExpired();
    await this.idle();
    const now = this.service.clock.now();
    const at = now.toISOString();
    for (const e of await this.store.list({ status: ['waiting'] })) {
      if (Date.parse(e.expires_at) <= now.getTime()) {
        await this.store.transition(e.waitlist_id, ['waiting'], 'expired', at);
      }
    }
    for (const e of await this.store.list({ status: ['offered'] })) {
      if (!e.offer || Date.parse(e.offer.expires_at) > now.getTime()) continue;
      // A claim that never got its hold (the instance died) lapses with its window. One with a
      // hold is settled by the expiry event that reading the booking raises.
      if (e.offer.booking_id) await this.service.getBooking(e.offer.booking_id).catch(() => {});
      else await this.#settleOffer(e, 'expired');
    }
    await this.idle();
    return this.store.purge(new Date(now.getTime() - this.#retentionMs).toISOString());
  }

  /** Every entry carrying this customer's email or phone number (data export). */
  async exportCustomer(match: WaitlistCustomerMatch, venueId?: string): Promise<WaitlistEntry[]> {
    return this.store.forCustomer(match, venueId);
  }

  /**
   * Delete this customer's entries (data erasure). A slot still held for them is released first,
   * so it is not left with a customer who no longer exists in our records. Resolves how many
   * entries were deleted.
   */
  async eraseCustomer(match: WaitlistCustomerMatch, venueId?: string): Promise<number> {
    for (const e of await this.store.forCustomer(match, venueId)) {
      if (e.status === 'offered' && e.offer?.booking_id) {
        await runAsActor(WAITLIST_ACTOR, () =>
          this.service.cancel({
            booking_id: e.offer!.booking_id!,
            idempotency_key: `waitlist-erase:${e.waitlist_id}`,
          }),
        ).catch(this.#onError);
      }
    }
    return this.store.eraseCustomer(match, venueId);
  }
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function notFound(waitlistId: string): BookingError {
  return new BookingError('not_found', `No waitlist entry with id "${waitlistId}".`, {
    suggested_next_action:
      'Check the waitlist_id. To wait for a full time, call join_waitlist; otherwise search_availability.',
  });
}
