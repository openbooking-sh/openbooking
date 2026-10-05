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
  });
}
