import { BookingError, type Booking } from '@openbooking-sh/core';

/** A booking plus the inventory it occupies. */
export interface BookingRecord {
  booking: Booking;
  resource_id: string;
  start_ms: number;
  /** End including turnover buffer. */
  end_ms: number;
}

export interface BookingListQuery {
  /** Only this venue's bookings (several businesses can share one store). */
  venue_id?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Where the configured provider keeps bookings. The provider owns the catalog and slot rules;
 * the store owns persistence and the one thing that must be atomic: check-and-reserve.
 *
 * All reads return bookings with expiry applied: a hold whose `expires_at` has passed is reported
 * as `expired` (and stops blocking inventory) whether or not it was ever written back.
 */
export interface BookingRecordStore {
  /** Records of a venue that block inventory at `now` and overlap [fromMs, toMs). */
  listBlocking(venueId: string, fromMs: number, toMs: number, now: Date): Promise<BookingRecord[]>;

  /**
   * Insert `record` only if no blocking record on the same resource overlaps it. Must be atomic
   * against concurrent calls (transaction + lock, or equivalent). Returns false when taken.
   */
  insertIfFree(record: BookingRecord, now: Date): Promise<boolean>;

  get(bookingId: string, now: Date): Promise<BookingRecord | undefined>;

  /**
   * Atomic read-modify-write. `fn` sees the current booking (expiry applied) and returns the new
   * one, or throws to abort without changes. Resolves undefined when the booking doesn't exist.
   *
   * If the new booking blocks inventory, the store must also check (atomically with
   * `insertIfFree`) that no other blocking record overlaps it, and throw {@link lostSlot}
   * otherwise. That closes the race where a hold lapses, another customer takes the time, and a
   * late confirm of the first hold arrives with a slightly older clock reading.
   */
  update(
    bookingId: string,
    now: Date,
    fn: (booking: Booking) => Booking,
  ): Promise<Booking | undefined>;

  /**
   * Move a booking to another resource and time (rescheduling), atomically: `check` runs on the
   * current booking (expiry applied) and throws to abort; then, atomically with `insertIfFree`,
   * the new interval must not overlap another blocking record. Resolves false when it does
   * (nothing changes). `record.booking.booking_id` and the venue stay the same.
   */
  move(record: BookingRecord, now: Date, check: (current: Booking) => void): Promise<boolean>;

  /** Newest first (by `created_at`), filtered by start time. */
  list(query: BookingListQuery, now: Date): Promise<BookingRecord[]>;

  /**
   * Remove the customer's name, contact details and notes from bookings, keeping the booking
   * itself (time, service, status) so the calendar history and statistics stay right. Optional:
   * a store that cannot do this simply lacks the method. See {@link selectForAnonymizing} for
   * which bookings qualify.
   */
  anonymize?(query: AnonymizeQuery, now: Date): Promise<AnonymizeResult>;
}

/** Who to find: by email, by phone number, or both. A booking matches when either one does. */
export interface CustomerMatch {
  email?: string;
  phone?: string;
}

export interface AnonymizeQuery {
  venue_id: string;
  /** Only this customer's bookings. */
  customer?: CustomerMatch;
  /** Only bookings that ended before this instant (retention). */
  ended_before?: Date;
}

export interface AnonymizeResult {
  /** Bookings whose personal data was removed. */
  anonymized: number;
  /** Matching bookings still ahead of us (held or confirmed): kept, the business still needs them. */
  kept_upcoming: number;
}

const digits = (s: string) => s.replace(/\D/g, '');

/** A phone number needs this many digits before it identifies anyone. */
const MIN_PHONE_DIGITS = 6;

/** Email is compared case-insensitively; phone numbers by their digits (so spacing doesn't matter). */
export function matchesCustomer(booking: Booking, match: CustomerMatch): boolean {
  const c = booking.customer;
  if (!c) return false;
  const email = match.email?.trim().toLowerCase();
  const phone = match.phone ? digits(match.phone) : '';
  return (
    (!!email && c.email?.toLowerCase() === email) ||
    (phone.length >= MIN_PHONE_DIGITS && !!c.phone_number && digits(c.phone_number) === phone)
  );
}

/** The booking without anyone's personal data. */
export function anonymizeBooking(booking: Booking): Booking {
  return { ...booking, customer: null, notes: null };
}

/** Refuses a query that would erase everything: it must name a customer or an age. */
export function assertAnonymizeQuery(query: AnonymizeQuery): void {
  const c = query.customer;
  const named = !!c && (!!c.email?.trim() || digits(c.phone ?? '').length >= MIN_PHONE_DIGITS);
  if (!named && !query.ended_before) {
    throw new BookingError(
      'validation_error',
      'Give an email address or phone number, or how old the bookings must be.',
    );
  }
  if (c && !named) {
    throw new BookingError('validation_error', 'Give an email address or a full phone number.');
  }
}

/**
 * Which bookings `anonymize` touches: this venue's, still carrying personal data, matching the
 * customer and age filters. Upcoming bookings (held or confirmed, not yet ended) are counted and
 * kept, so erasing a customer never loses who is coming tomorrow; cancel them first to erase them.
 */
export function selectForAnonymizing(
  records: Iterable<BookingRecord>,
  query: AnonymizeQuery,
  now: Date,
): { ids: string[]; keptUpcoming: number } {
  const ids: string[] = [];
  let keptUpcoming = 0;
  for (const r of records) {
    const b = r.booking;
    if (b.venue_id !== query.venue_id || (!b.customer && !b.notes)) continue;
    if (query.customer && !matchesCustomer(b, query.customer)) continue;
    if (query.ended_before && r.end_ms >= query.ended_before.getTime()) continue;
    if (r.end_ms > now.getTime() && isBlocking(b, now)) {
      keptUpcoming++;
      continue;
    }
    ids.push(b.booking_id);
  }
  return { ids, keptUpcoming };
}

/** The error stores throw when a confirm loses its slot to a newer hold. */
export function lostSlot(): BookingError {
  return new BookingError(
    'hold_expired',
    'The hold lapsed and the time was taken by someone else.',
    {
      suggested_next_action: 'Search availability again and offer the user another time.',
    },
  );
}

/** Report a lapsed hold as `expired`. Pure; stores call this on every read. */
export function applyExpiry(booking: Booking, now: Date): Booking {
  if (
    booking.status === 'held' &&
    booking.expires_at &&
    new Date(booking.expires_at).getTime() <= now.getTime()
  ) {
    return { ...booking, status: 'expired', updated_at: booking.expires_at };
  }
  return booking;
}

/** Whether a booking occupies its resource at `now`. */
export function isBlocking(booking: Booking, now: Date): boolean {
  return (
    booking.status === 'confirmed' ||
    (booking.status === 'held' &&
      !!booking.expires_at &&
      new Date(booking.expires_at).getTime() > now.getTime())
  );
}

/**
 * Default store: a Map. Each method runs synchronously between its first and last line (no
 * awaits), so check-and-reserve is atomic on Node's single thread.
 */
export class MemoryBookingStore implements BookingRecordStore {
  readonly #records = new Map<string, BookingRecord>();

  async listBlocking(venueId: string, fromMs: number, toMs: number, now: Date) {
    return [...this.#records.values()]
      .filter(
        (r) =>
          r.booking.venue_id === venueId &&
          r.start_ms < toMs &&
          fromMs < r.end_ms &&
          isBlocking(r.booking, now),
      )
      .map(clone);
  }

  async insertIfFree(record: BookingRecord, now: Date) {
    if (this.#overlaps(record, now)) return false;
    this.#records.set(record.booking.booking_id, clone(record));
    return true;
  }

  async get(bookingId: string, now: Date) {
    const r = this.#records.get(bookingId);
    if (!r) return undefined;
    const copy = clone(r);
    return { ...copy, booking: applyExpiry(copy.booking, now) };
  }

  async update(bookingId: string, now: Date, fn: (booking: Booking) => Booking) {
    const r = this.#records.get(bookingId);
    if (!r) return undefined;
    const next = fn(applyExpiry(structuredClone(r.booking), now));
    if (isBlocking(next, now) && this.#overlaps(r, now)) throw lostSlot();
    r.booking = structuredClone(next);
    return structuredClone(next);
  }

  async move(record: BookingRecord, now: Date, check: (current: Booking) => void) {
    const id = record.booking.booking_id;
    const r = this.#records.get(id);
    if (!r) throw new BookingError('not_found', `No booking with id "${id}".`);
    check(applyExpiry(structuredClone(r.booking), now));
    if (this.#overlaps(record, now)) return false;
    this.#records.set(id, structuredClone(record));
    return true;
  }

  /** Another blocking record on the same resource overlaps `record`. */
  #overlaps(record: BookingRecord, now: Date): boolean {
    for (const r of this.#records.values()) {
      if (
        r.booking.booking_id !== record.booking.booking_id &&
        r.resource_id === record.resource_id &&
        r.booking.venue_id === record.booking.venue_id &&
        r.start_ms < record.end_ms &&
        record.start_ms < r.end_ms &&
        isBlocking(r.booking, now)
      ) {
        return true;
      }
    }
    return false;
  }

  async anonymize(query: AnonymizeQuery, now: Date) {
    assertAnonymizeQuery(query);
    const { ids, keptUpcoming } = selectForAnonymizing(this.#records.values(), query, now);
    for (const id of ids) {
      const r = this.#records.get(id)!;
      r.booking = anonymizeBooking(r.booking);
    }
    return { anonymized: ids.length, kept_upcoming: keptUpcoming };
  }

  async list(query: BookingListQuery, now: Date) {
    return [...this.#records.values()]
      .filter(
        (r) =>
          (!query.venue_id || r.booking.venue_id === query.venue_id) &&
          (!query.from || r.start_ms >= query.from.getTime()) &&
          (!query.to || r.start_ms < query.to.getTime()),
      )
      .map((r) => {
        const copy = clone(r);
        return { ...copy, booking: applyExpiry(copy.booking, now) };
      })
      .sort((a, b) => (a.booking.created_at < b.booking.created_at ? 1 : -1))
      .slice(0, query.limit ?? 500);
  }
}

const clone = (r: BookingRecord): BookingRecord => structuredClone(r);
