import {
  FINAL_WAITLIST_STATUSES,
  type WaitlistCustomerMatch,
  type WaitlistEntry,
  type WaitlistQuery,
  type WaitlistStatus,
  type WaitlistStore,
} from '@openbooking-sh/core';
import { json, type Db } from './db';

const MIN_PHONE_DIGITS = 6;

/** What a data request can match on: the lower-cased email and the digits of the phone number. */
function keys(match: WaitlistCustomerMatch): { email: string | null; phone: string | null } {
  const email = match.email?.trim().toLowerCase() || null;
  const digits = (match.phone ?? '').replace(/\D/g, '');
  return { email, phone: digits.length >= MIN_PHONE_DIGITS ? digits : null };
}

/**
 * The waitlist in Postgres, shared by every server instance. Each change locks the entry's row
 * (`for update`), checks it is still in the state the caller expects, and writes the next one, so
 * of several instances racing to claim an entry exactly one wins. `seq` keeps the order people
 * joined. Email and phone digits sit in their own columns so a data request can find and delete
 * an entry without reading every row; the entry itself is the `data` JSON.
 */
export class PostgresWaitlistStore implements WaitlistStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(entry: WaitlistEntry): Promise<void> {
    const k = keys({
      email: entry.customer.email,
      phone: entry.customer.phone_number,
    });
    await this.#db.query(
      `insert into ob_waitlist
         (waitlist_id, venue_id, date, status, offer_booking_id, email, phone_digits,
          created_at, updated_at, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::jsonb)`,
      [
        entry.waitlist_id,
        entry.venue_id,
        entry.date,
        entry.status,
        entry.offer?.booking_id ?? null,
        k.email,
        k.phone,
        entry.created_at,
        entry.updated_at,
        json(entry),
      ],
    );
  }

  async get(waitlistId: string) {
    const { rows } = await this.#db.query<{ data: WaitlistEntry }>(
      'select data from ob_waitlist where waitlist_id = $1',
      [waitlistId],
    );
    return rows[0]?.data;
  }

  async findByOffer(bookingId: string) {
    const { rows } = await this.#db.query<{ data: WaitlistEntry }>(
      'select data from ob_waitlist where offer_booking_id = $1',
      [bookingId],
    );
    return rows[0]?.data;
  }

  async list(query: WaitlistQuery = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.venue_id) where.push(`venue_id = $${params.push(query.venue_id)}`);
    if (query.date) where.push(`date = $${params.push(query.date)}`);
    if (query.status) where.push(`status = any($${params.push(query.status)}::text[])`);
    const limit = query.limit ? `limit $${params.push(query.limit)}` : '';
    const { rows } = await this.#db.query<{ data: WaitlistEntry }>(
      `select data from ob_waitlist ${where.length ? `where ${where.join(' and ')}` : ''}
        order by seq ${limit}`,
      params,
    );
    return rows.map((r) => r.data);
  }

  claim(
    waitlistId: string,
    offer: { offered_at: string; expires_at: string },
    at: string,
  ): Promise<WaitlistEntry | undefined> {
    return this.#change(
      waitlistId,
      (e) => e.status === 'waiting',
      (e) => ({ ...e, status: 'offered', updated_at: at, offer: { booking_id: null, ...offer } }),
    );
  }

  attachOffer(
    waitlistId: string,
    offer: { booking_id: string; expires_at: string },
    at: string,
  ): Promise<WaitlistEntry | undefined> {
    return this.#change(
      waitlistId,
      (e) => e.status === 'offered' && !!e.offer && e.offer.booking_id === null,
      (e) => ({ ...e, updated_at: at, offer: { ...e.offer!, ...offer } }),
    );
  }

  release(waitlistId: string, at: string): Promise<WaitlistEntry | undefined> {
    return this.#change(
      waitlistId,
      (e) => e.status === 'offered' && !!e.offer && e.offer.booking_id === null,
      (e) => ({ ...e, status: 'waiting', updated_at: at, offer: null }),
    );
  }

  transition(
    waitlistId: string,
    from: readonly WaitlistStatus[],
    to: WaitlistStatus,
    at: string,
  ): Promise<WaitlistEntry | undefined> {
    return this.#change(
      waitlistId,
      (e) => from.includes(e.status),
      (e) => ({ ...e, status: to, updated_at: at }),
    );
  }

  async forCustomer(match: WaitlistCustomerMatch, venueId?: string) {
    const k = keys(match);
    if (!k.email && !k.phone) return [];
    const { rows } = await this.#db.query<{ data: WaitlistEntry }>(
      `select data from ob_waitlist
        where (email = $1 or phone_digits = $2) and ($3::text is null or venue_id = $3)
        order by seq`,
      [k.email, k.phone, venueId ?? null],
    );
    return rows.map((r) => r.data);
  }

  async eraseCustomer(match: WaitlistCustomerMatch, venueId?: string) {
    const k = keys(match);
    if (!k.email && !k.phone) return 0;
    const { rows } = await this.#db.query(
      `delete from ob_waitlist
        where (email = $1 or phone_digits = $2) and ($3::text is null or venue_id = $3)
        returning waitlist_id`,
      [k.email, k.phone, venueId ?? null],
    );
    return rows.length;
  }

  async deleteVenue(venueId: string) {
    const { rows } = await this.#db.query(
      'delete from ob_waitlist where venue_id = $1 returning waitlist_id',
      [venueId],
    );
    return rows.length;
  }

  async purge(before: string) {
    const { rows } = await this.#db.query(
      `delete from ob_waitlist
        where status = any($1::text[]) and updated_at < $2::timestamptz
        returning waitlist_id`,
      [[...FINAL_WAITLIST_STATUSES], before],
    );
    return rows.length;
  }

  async #change(
    waitlistId: string,
    expected: (entry: WaitlistEntry) => boolean,
    next: (entry: WaitlistEntry) => WaitlistEntry,
  ): Promise<WaitlistEntry | undefined> {
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.query<{ data: WaitlistEntry }>(
        'select data from ob_waitlist where waitlist_id = $1 for update',
        [waitlistId],
      );
      const current = rows[0]?.data;
      if (!current || !expected(current)) return undefined;
      const updated = next(current);
      await tx.query(
        `update ob_waitlist
            set status = $2, offer_booking_id = $3, updated_at = $4::timestamptz, data = $5::jsonb
          where waitlist_id = $1`,
        [
          waitlistId,
          updated.status,
          updated.offer?.booking_id ?? null,
          updated.updated_at,
          json(updated),
        ],
      );
      return updated;
    });
  }
}
