/**
 * Behaviour every BookingRecordStore must have. Run with `describeBookingStore(name, factory)`;
 * used for the memory store here and for the Postgres store in @openbooking-sh/postgres.
 */
import { BookingError, type Booking } from '@openbooking-sh/core';
import { describe, expect, it } from 'vitest';
import type { BookingRecord, BookingRecordStore } from '../src/store';

const T0 = Date.parse('2030-06-01T10:00:00Z');
const MIN = 60_000;
const at = (ms: number) => new Date(ms);

let seq = 0;
export function record(
  over: {
    id?: string;
    venue?: string;
    resource?: string;
    start?: number;
    minutes?: number;
    status?: Booking['status'];
    expires?: number | null;
    created?: number;
  } = {},
): BookingRecord {
  const start = over.start ?? T0;
  const end = start + (over.minutes ?? 30) * MIN;
  const id = over.id ?? `bk_test_${++seq}`;
  const status = over.status ?? 'held';
  const expires = over.expires === undefined ? (status === 'held' ? T0 : null) : over.expires;
  const created = new Date(over.created ?? T0 - 60 * MIN + seq).toISOString();
  return {
    booking: {
      booking_id: id,
      status,
      venue_id: over.venue ?? 'v1',
      slot: {
        slot_id: `slot_${id}`,
        venue_id: over.venue ?? 'v1',
        offering: { id: 'cut', name: 'Haircut' },
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        party_size: { total: 1 },
        resource: { id: over.resource ?? 'r1', kind: 'staff', label: 'Maria', tags: [] },
        price: null,
        deposit: null,
        cancellation_policy: {
          refundability: 'refundable',
          description: 'Free cancellation.',
          free_cancellation_until: null,
          late_cancellation_fee: null,
          no_show_fee: null,
        },
      },
      customer: null,
      notes: null,
      expires_at: expires === null ? null : new Date(expires).toISOString(),
      confirmation_code: null,
      payment: { status: 'not_required', amount: null, reference: null },
      cancellation: null,
      created_at: created,
      updated_at: created,
      confirmed_at: null,
      cancelled_at: null,
    } as Booking,
    resource_id: over.resource ?? 'r1',
    start_ms: start,
    end_ms: end,
  };
}

/** A hold that is live at T0 - 5 min. */
const NOW = at(T0 - 5 * MIN);

export function describeBookingStore(
  name: string,
  factory: () => Promise<BookingRecordStore> | BookingRecordStore,
): void {
  describe(`BookingRecordStore contract: ${name}`, () => {
    it('rejects an overlapping insert on the same resource, allows others', async () => {
      const store = await factory();
      expect(await store.insertIfFree(record({ id: 'a' }), NOW)).toBe(true);
      // Overlaps by 10 minutes on r1.
      expect(await store.insertIfFree(record({ id: 'b', start: T0 + 20 * MIN }), NOW)).toBe(false);
      // Same time on another resource, another venue, and back-to-back on r1 are all fine.
      expect(await store.insertIfFree(record({ id: 'c', resource: 'r2' }), NOW)).toBe(true);
      expect(await store.insertIfFree(record({ id: 'd', venue: 'v2' }), NOW)).toBe(true);
      expect(await store.insertIfFree(record({ id: 'e', start: T0 + 30 * MIN }), NOW)).toBe(true);
      expect(await store.get('b', NOW)).toBeUndefined();
    });

    it('lets exactly one of many concurrent inserts win', async () => {
      const store = await factory();
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          store.insertIfFree(record({ id: `race_${i}`, start: T0 + i * MIN }), NOW),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('reports lapsed holds as expired and stops them blocking', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'h', expires: T0 - MIN }), NOW);
      const later = at(T0 - 30_000);
      expect((await store.get('h', later))?.booking).toMatchObject({
        status: 'expired',
        updated_at: new Date(T0 - MIN).toISOString(),
      });
      expect(await store.listBlocking('v1', T0 - 60 * MIN, T0 + 60 * MIN, later)).toEqual([]);
      expect(await store.insertIfFree(record({ id: 'h2' }), later)).toBe(true);
    });

    it('lists blocking records by venue and time range', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'in', status: 'confirmed' }), NOW);
      await store.insertIfFree(record({ id: 'other_venue', venue: 'v2' }), NOW);
      await store.insertIfFree(record({ id: 'later', start: T0 + 180 * MIN }), NOW);
      await store.insertIfFree(
        record({ id: 'cancelled', resource: 'r3', status: 'cancelled' }),
        NOW,
      );
      const ids = (await store.listBlocking('v1', T0 - 30 * MIN, T0 + 60 * MIN, NOW)).map(
        (r) => r.booking.booking_id,
      );
      expect(ids).toEqual(['in']);
    });

    it('updates atomically and rolls back when fn throws', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'u' }), NOW);
      const confirmed = await store.update('u', NOW, (b) => ({
        ...b,
        status: 'confirmed',
        expires_at: null,
        notes: 'window seat',
      }));
      expect(confirmed).toMatchObject({ status: 'confirmed', notes: 'window seat' });
      await expect(
        store.update('u', NOW, () => {
          throw new BookingError('invalid_state', 'nope');
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      expect((await store.get('u', NOW))?.booking).toMatchObject({
        status: 'confirmed',
        notes: 'window seat',
      });
      expect(await store.update('missing', NOW, (b) => b)).toBeUndefined();
    });

    it('a late confirm cannot take a slot that was re-booked after its hold lapsed', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'first', expires: T0 - 2 * MIN }), NOW);
      // After the first hold lapsed, someone else holds the same time.
      expect(await store.insertIfFree(record({ id: 'second' }), at(T0 - MIN))).toBe(true);
      // The first customer's confirm arrives carrying an older clock reading.
      await expect(
        store.update('first', at(T0 - 3 * MIN), (b) => ({
          ...b,
          status: 'confirmed',
          expires_at: null,
        })),
      ).rejects.toMatchObject({ code: 'hold_expired' });
      // Cancelling (non-blocking) is always allowed.
      const cancelled = await store.update('first', at(T0 - MIN), (b) => ({
        ...b,
        status: 'cancelled',
        expires_at: null,
      }));
      expect(cancelled?.status).toBe('cancelled');
    });

    it('moves a booking to a free time or resource, keeping its id, and refuses a taken one', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'm', status: 'confirmed', expires: null }), NOW);
      await store.insertIfFree(
        record({ id: 'busy', status: 'confirmed', expires: null, start: T0 + 120 * MIN }),
        NOW,
      );
      const moved = (start: number, resource = 'r1') => ({
        ...record({ id: 'm', status: 'confirmed', expires: null, start, resource }),
      });
      // Overlaps 'busy' on r1: refused, nothing changes.
      expect(await store.move(moved(T0 + 110 * MIN), NOW, () => {})).toBe(false);
      expect((await store.get('m', NOW))?.start_ms).toBe(T0);
      // Overlapping only itself is fine (moving 15 minutes later).
      expect(await store.move(moved(T0 + 15 * MIN), NOW, () => {})).toBe(true);
      // Same time as 'busy' but on another resource is fine too.
      expect(await store.move(moved(T0 + 120 * MIN, 'r2'), NOW, () => {})).toBe(true);
      const now = await store.get('m', NOW);
      expect(now).toMatchObject({ resource_id: 'r2', start_ms: T0 + 120 * MIN });
      expect(now?.booking.booking_id).toBe('m');
      // The old time on r1 is free again; the new one on r2 is taken.
      expect(await store.insertIfFree(record({ id: 'x1' }), NOW)).toBe(true);
      expect(
        await store.insertIfFree(record({ id: 'x2', resource: 'r2', start: T0 + 120 * MIN }), NOW),
      ).toBe(false);
      // check() can abort; a missing booking is not_found.
      await expect(
        store.move(moved(T0 + 240 * MIN), NOW, () => {
          throw new BookingError('invalid_state', 'nope');
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      expect((await store.get('m', NOW))?.start_ms).toBe(T0 + 120 * MIN);
      await expect(
        store.move(record({ id: 'ghost', status: 'confirmed' }), NOW, () => {}),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('lets exactly one of two concurrent moves into the same time win', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'p', status: 'confirmed', expires: null }), NOW);
      await store.insertIfFree(
        record({ id: 'q', status: 'confirmed', expires: null, resource: 'r2' }),
        NOW,
      );
      const target = T0 + 300 * MIN;
      const results = await Promise.all([
        store.move(
          record({ id: 'p', status: 'confirmed', expires: null, start: target, resource: 'r3' }),
          NOW,
          () => {},
        ),
        store.move(
          record({ id: 'q', status: 'confirmed', expires: null, start: target, resource: 'r3' }),
          NOW,
          () => {},
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('lists newest first with start-time filters and limit', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'l1', created: T0 - 50 * MIN }), NOW);
      await store.insertIfFree(
        record({ id: 'l2', resource: 'r2', start: T0 + 60 * MIN, created: T0 - 40 * MIN }),
        NOW,
      );
      await store.insertIfFree(
        record({ id: 'l3', resource: 'r3', start: T0 + 120 * MIN, created: T0 - 30 * MIN }),
        NOW,
      );
      const ids = async (q: Parameters<BookingRecordStore['list']>[0]) =>
        (await store.list(q, NOW)).map((r) => r.booking.booking_id);
      expect(await ids({})).toEqual(['l3', 'l2', 'l1']);
      expect(await ids({ limit: 2 })).toEqual(['l3', 'l2']);
      expect(await ids({ from: at(T0 + 60 * MIN) })).toEqual(['l3', 'l2']);
      expect(await ids({ to: at(T0 + 60 * MIN) })).toEqual(['l1']);
      const [one] = await store.list({ limit: 1 }, NOW);
      expect(one).toMatchObject({ resource_id: 'r3', start_ms: T0 + 120 * MIN });
    });

    it('lists one venue when venue_id is given', async () => {
      const store = await factory();
      await store.insertIfFree(record({ id: 'a1' }), NOW);
      await store.insertIfFree(record({ id: 'b1', venue: 'v2' }), NOW);
      const ids = async (venue_id: string) =>
        (await store.list({ venue_id }, NOW)).map((r) => r.booking.booking_id);
      expect(await ids('v1')).toEqual(['a1']);
      expect(await ids('v2')).toEqual(['b1']);
    });

    describe('anonymize', () => {
      const ada = {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'Ada@Example.com',
        phone_number: '+47 123 45 678',
      };
      /** A booking carrying a customer, `days` from the contract's clock (negative = in the past). */
      const withCustomer = (id: string, days: number, over: Parameters<typeof record>[0] = {}) => {
        const r = record({ id, status: 'confirmed', start: T0 + days * 86_400_000, ...over });
        r.booking.customer = ada;
        r.booking.notes = 'Allergic to latex';
        return r;
      };

      it('removes the customer and notes from their finished bookings, nothing else', async () => {
        const store = await factory();
        const past = withCustomer('past', -10);
        const other = withCustomer('other', -10, { resource: 'r2' });
        other.booking.customer = { first_name: 'Bob', last_name: 'Berg', email: 'bob@example.com' };
        await store.insertIfFree(past, NOW);
        await store.insertIfFree(other, NOW);

        // Email in another case, phone in another format: both identify the same customer.
        const r = await store.anonymize!(
          { venue_id: 'v1', customer: { email: 'ada@example.COM' } },
          NOW,
        );
        expect(r).toEqual({ anonymized: 1, kept_upcoming: 0 });

        const got = (await store.get('past', NOW))!.booking;
        expect(got.customer).toBeNull();
        expect(got.notes).toBeNull();
        expect(got.status).toBe('confirmed');
        expect(got.slot).toEqual(past.booking.slot);
        expect((await store.get('other', NOW))!.booking.customer?.first_name).toBe('Bob');

        // Nothing left to remove: a second run changes nothing.
        expect(
          await store.anonymize!({ venue_id: 'v1', customer: { email: 'ada@example.com' } }, NOW),
        ).toEqual({ anonymized: 0, kept_upcoming: 0 });
      });

      it('finds a customer by phone number whatever the spacing', async () => {
        const store = await factory();
        await store.insertIfFree(withCustomer('p1', -3), NOW);
        const r = await store.anonymize!(
          { venue_id: 'v1', customer: { phone: '+4712345678' } },
          NOW,
        );
        expect(r?.anonymized).toBe(1);
      });

      it('keeps upcoming bookings and says how many, until they are cancelled', async () => {
        const store = await factory();
        await store.insertIfFree(withCustomer('soon', 3), NOW);
        const query = { venue_id: 'v1', customer: { email: 'ada@example.com' } };
        expect(await store.anonymize!(query, NOW)).toEqual({ anonymized: 0, kept_upcoming: 1 });
        expect((await store.get('soon', NOW))!.booking.customer?.first_name).toBe('Ada');

        await store.update('soon', NOW, (b) => ({ ...b, status: 'cancelled' }));
        expect(await store.anonymize!(query, NOW)).toEqual({ anonymized: 1, kept_upcoming: 0 });
        expect((await store.get('soon', NOW))!.booking.customer).toBeNull();
      });

      it('removes personal data from old bookings only, in one venue only', async () => {
        const store = await factory();
        await store.insertIfFree(withCustomer('old', -400), NOW);
        await store.insertIfFree(withCustomer('recent', -10), NOW);
        await store.insertIfFree(withCustomer('elsewhere', -400, { venue: 'v2' }), NOW);

        const cutoff = new Date(NOW.getTime() - 365 * 86_400_000);
        const r = await store.anonymize!({ venue_id: 'v1', ended_before: cutoff }, NOW);
        expect(r).toEqual({ anonymized: 1, kept_upcoming: 0 });
        expect((await store.get('old', NOW))!.booking.customer).toBeNull();
        expect((await store.get('recent', NOW))!.booking.customer).not.toBeNull();
        expect((await store.get('elsewhere', NOW))!.booking.customer).not.toBeNull();
      });

      it('refuses a query that names nobody and no age, so it can never erase everything', async () => {
        const store = await factory();
        await store.insertIfFree(withCustomer('x', -10), NOW);
        await expect(store.anonymize!({ venue_id: 'v1' }, NOW)).rejects.toMatchObject({
          code: 'validation_error',
        });
        await expect(store.anonymize!({ venue_id: 'v1', customer: {} }, NOW)).rejects.toMatchObject(
          { code: 'validation_error' },
        );
        await expect(
          store.anonymize!({ venue_id: 'v1', customer: { phone: '123' } }, NOW),
        ).rejects.toMatchObject({ code: 'validation_error' });
        expect((await store.get('x', NOW))!.booking.customer).not.toBeNull();
      });
    });
  });
}
