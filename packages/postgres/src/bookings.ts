import { BookingError, type Booking } from '@openbooking-sh/core';
import {
  applyExpiry,
  assertAnonymizeQuery,
  isBlocking,
  lostSlot,
  selectForAnonymizing,
  type AnonymizeQuery,
  type BookingListQuery,
  type BookingRecord,
  type BookingRecordStore,
} from '@openbooking-sh/provider-memory';
import { LOCK_SQL, json, type Db, type Queryable } from './db';

interface Row {
  resource_id: string;
  start_at: Date;
  end_at: Date;
  data: Booking;
}

const COLUMNS = 'resource_id, start_at, end_at, data';
const BLOCKING = `(status = 'confirmed' or (status = 'held' and expires_at > $NOW::timestamptz))`;

/**
 * Bookings and holds in Postgres, for the configured provider (`MemoryBookingProvider`'s catalog
 * with durable storage).
 *
 * Check-and-reserve takes a transaction-scoped advisory lock per venue resource, then checks for
 * a blocking overlap and inserts. Every writer to a resource holds that lock, so two overlapping
 * holds can never both commit, across any number of server instances.
 */
export class PostgresBookingStore implements BookingRecordStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listBlocking(venueId: string, fromMs: number, toMs: number, now: Date) {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from ob_bookings
        where venue_id = $1 and start_at < $3::timestamptz and end_at > $2::timestamptz
          and ${BLOCKING.replace('$NOW', '$4')}`,
      [venueId, iso(fromMs), iso(toMs), now.toISOString()],
    );
    return rows.map((r) => toRecord(r, now));
  }

  async insertIfFree(record: BookingRecord, now: Date) {
    const b = record.booking;
    return this.#db.transaction(async (tx) => {
      await tx.query(LOCK_SQL, [lockKey(b.venue_id, record.resource_id)]);
      if (await overlapExists(tx, record, now)) return false;
      await tx.query(
        `insert into ob_bookings
           (booking_id, venue_id, resource_id, start_at, end_at, status, expires_at, created_at, data)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::timestamptz,
                 $8::timestamptz, $9::jsonb)`,
        [
          b.booking_id,
          b.venue_id,
          record.resource_id,
          iso(record.start_ms),
          iso(record.end_ms),
          b.status,
          b.expires_at,
          b.created_at,
          json(b),
        ],
      );
      return true;
    });
  }

  async get(bookingId: string, now: Date) {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from ob_bookings where booking_id = $1`,
      [bookingId],
    );
    return rows[0] ? toRecord(rows[0], now) : undefined;
  }

  async update(bookingId: string, now: Date, fn: (booking: Booking) => Booking) {
    return this.#db.transaction(async (tx) => {
      // venue and resource never change, so read them first to take the same lock as inserts.
      const { rows: keys } = await tx.query<{ venue_id: string; resource_id: string }>(
        'select venue_id, resource_id from ob_bookings where booking_id = $1',
        [bookingId],
      );
      const key = keys[0];
      if (!key) return undefined;
      await tx.query(LOCK_SQL, [lockKey(key.venue_id, key.resource_id)]);
      const { rows } = await tx.query<Row>(
        `select ${COLUMNS} from ob_bookings where booking_id = $1 for update`,
        [bookingId],
      );
      const record = toRecord(rows[0]!, now);
      const next = fn(record.booking);
      if (isBlocking(next, now) && (await overlapExists(tx, { ...record, booking: next }, now))) {
        throw lostSlot();
      }
      await tx.query(
        `update ob_bookings set status = $2, expires_at = $3::timestamptz, data = $4::jsonb
          where booking_id = $1`,
        [bookingId, next.status, next.expires_at, json(next)],
      );
      return next;
    });
  }

  async move(record: BookingRecord, now: Date, check: (current: Booking) => void) {
    const b = record.booking;
    return this.#db.transaction(async (tx) => {
      const { rows: keys } = await tx.query<{ venue_id: string; resource_id: string }>(
        'select venue_id, resource_id from ob_bookings where booking_id = $1',
        [b.booking_id],
      );
      const key = keys[0];
      if (!key) throw new BookingError('not_found', `No booking with id "${b.booking_id}".`);
      // Lock the old and the new resource in a fixed order, so two moves in opposite directions
      // can't deadlock; inserts on either resource wait for us.
      const locks = [
        ...new Set([
          lockKey(key.venue_id, key.resource_id),
          lockKey(b.venue_id, record.resource_id),
        ]),
      ].sort();
      for (const lock of locks) await tx.query(LOCK_SQL, [lock]);
      const { rows } = await tx.query<Row>(
        `select ${COLUMNS} from ob_bookings where booking_id = $1 for update`,
        [b.booking_id],
      );
      check(toRecord(rows[0]!, now).booking);
      if (await overlapExists(tx, record, now)) return false;
      await tx.query(
        `update ob_bookings set resource_id = $2, start_at = $3::timestamptz, end_at = $4::timestamptz,
            status = $5, expires_at = $6::timestamptz, data = $7::jsonb
          where booking_id = $1`,
        [
          b.booking_id,
          record.resource_id,
          iso(record.start_ms),
          iso(record.end_ms),
          b.status,
          b.expires_at,
          json(b),
        ],
      );
      return true;
    });
  }

  async deleteVenue(venueId: string) {
    const { rows } = await this.#db.query(
      'delete from ob_bookings where venue_id = $1 returning booking_id',
      [venueId],
    );
    return rows.length;
  }

  async anonymize(query: AnonymizeQuery, now: Date) {
    assertAnonymizeQuery(query);
    return this.#db.transaction(async (tx) => {
      const params: unknown[] = [query.venue_id];
      let ended = '';
      if (query.ended_before) {
        params.push(query.ended_before.toISOString());
        ended = 'and end_at < $2::timestamptz';
      }
      // Only rows that still carry personal data; the customer match itself runs in TypeScript
      // (selectForAnonymizing), so the memory and Postgres stores agree on who matches.
      const { rows } = await tx.query<Row>(
        `select ${COLUMNS} from ob_bookings
          where venue_id = $1 ${ended}
            and (coalesce(data->'customer', 'null'::jsonb) <> 'null'::jsonb
              or coalesce(data->'notes', 'null'::jsonb) <> 'null'::jsonb)
          for update`,
        params,
      );
      const { ids, keptUpcoming } = selectForAnonymizing(
        rows.map((r) => toRecord(r, now)),
        query,
        now,
      );
      if (ids.length) {
        // jsonb_set keeps every other field exactly as stored (status, expiry, times).
        await tx.query(
          `update ob_bookings
              set data = jsonb_set(jsonb_set(data, '{customer}', 'null'::jsonb), '{notes}', 'null'::jsonb)
            where booking_id = any($1::text[])`,
          [ids],
        );
      }
      return { anonymized: ids.length, kept_upcoming: keptUpcoming };
    });
  }

  async list(query: BookingListQuery, now: Date) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.venue_id) {
      params.push(query.venue_id);
      where.push(`venue_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from.toISOString());
      where.push(`start_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to.toISOString());
      where.push(`start_at < $${params.length}::timestamptz`);
    }
    params.push(query.limit ?? 500);
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from ob_bookings
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by created_at desc, booking_id desc
        limit $${params.length}`,
      params,
    );
    return rows.map((r) => toRecord(r, now));
  }
}

async function overlapExists(tx: Queryable, record: BookingRecord, now: Date): Promise<boolean> {
  const { rows } = await tx.query(
    `select 1 from ob_bookings
      where venue_id = $1 and resource_id = $2 and booking_id <> $3
        and start_at < $5::timestamptz and end_at > $4::timestamptz
        and ${BLOCKING.replace('$NOW', '$6')}
      limit 1`,
    [
      record.booking.venue_id,
      record.resource_id,
      record.booking.booking_id,
      iso(record.start_ms),
      iso(record.end_ms),
      now.toISOString(),
    ],
  );
  return rows.length > 0;
}

function toRecord(row: Row, now: Date): BookingRecord {
  return {
    booking: applyExpiry(row.data, now),
    resource_id: row.resource_id,
    start_ms: new Date(row.start_at).getTime(),
    end_ms: new Date(row.end_at).getTime(),
  };
}

const lockKey = (venueId: string, resourceId: string) => `openbooking:${venueId}/${resourceId}`;
const iso = (ms: number) => new Date(ms).toISOString();
