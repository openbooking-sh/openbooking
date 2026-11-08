/**
 * Joined tables, written once and run against every store (memory here, Postgres in
 * packages/postgres): the engine on top of a store must never put one table into two bookings,
 * however holds, confirms, cancels and moves interleave. Each case builds fresh stores.
 */
import { describe, expect, it } from 'vitest';
import {
  BookingService,
  ManualClock,
  type Booking,
  type Resource,
  type Slot,
} from '@openbooking-sh/core';
import { MemoryBookingProvider } from '../src';
import type { BookingRecordStore, VenueConfig } from '../src';
import { forEachSeed, FUZZ_TIMEOUT, ticks } from './fuzz';

// Wednesday, outside any DST change in Oslo; "now" is two days earlier.
export const DAY = '2026-10-14';
const NOW = '2026-10-12T08:00:00Z';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

const table = (id: string, min: number, max: number): Resource => ({
  id,
  venue_id: 'r',
  kind: 'table',
  name: `Table ${id.toUpperCase()}`,
  capacity: { min, max },
  tags: [],
});

/**
 * Two 3-tops (p1, p2), three 4-tops (f1..f3) and, optionally, one 8-top. The combinations are
 * listed with the wasteful one first, so choosing p1+p2 for six proves the order is by waste.
 */
export function combinationVenue(opts: { big?: boolean; extraBuffer?: number } = {}): VenueConfig {
  return {
    venue: { id: 'r', name: 'Test Bistro', timezone: 'Europe/Oslo', currency: 'NOK' },
    currency: 'NOK',
    resources: [
      table('p1', 1, 3),
      table('p2', 1, 3),
      table('f1', 1, 4),
      table('f2', 1, 4),
      table('f3', 1, 4),
      ...(opts.big ? [table('big', 5, 8)] : []),
    ],
    table_combinations: [
      {
        resource_ids: ['f1', 'f2'],
        min_party_size: 5,
        max_party_size: 8,
        ...(opts.extraBuffer ? { extra_buffer_minutes: opts.extraBuffer } : {}),
      },
      { resource_ids: ['p1', 'p2'], min_party_size: 5, max_party_size: 6 },
      { resource_ids: ['f2', 'f3'], min_party_size: 5, max_party_size: 8 },
    ],
    offerings: [
      {
        id: 'dinner',
        venue_id: 'r',
        name: 'Dinner',
        duration_minutes: 90,
        price_per_person: null,
        resource_kinds: ['table'],
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: 24,
          late_fee_per_person: null,
          no_show_fee_per_person: null,
        },
        deposit: null,
      },
    ],
    opening_hours: { 3: [{ open: '17:00', close: '23:00' }] },
    slot_interval_minutes: 30,
    buffer_minutes: 15,
    min_lead_minutes: 30,
    max_days_ahead: 30,
  };
}

export interface Rig {
  a: BookingService;
  b: BookingService;
  provider: MemoryBookingProvider;
  clock: ManualClock;
}

/** Two engine instances (like two server processes) on one store. */
export function rig(store: BookingRecordStore, cfg: VenueConfig): Rig {
  const clock = new ManualClock(NOW);
  const make = () => {
    const provider = new MemoryBookingProvider({ name: 'T', venues: [cfg] }, { store });
    return { provider, service: new BookingService({ provider, clock, holdLimit: false }) };
  };
  const a = make();
  return { a: a.service, b: make().service, provider: a.provider, clock };
}

let n = 0;
export const key = () => `combo-key-${++n}`;

export async function slotsAt(s: BookingService, party: number, at = '19:00'): Promise<Slot[]> {
  const { slots } = await s.searchAvailability({
    date: DAY,
    party_size: { total: party },
    time_from: at,
    time_to: at,
    limit: 50,
  });
  return slots;
}

export async function holdFor(s: BookingService, party: number, at = '19:00'): Promise<Booking> {
  const [slot] = await slotsAt(s, party, at);
  if (!slot) throw new Error(`no slot for ${party} at ${at}`);
  return s.hold({ slot_id: slot.slot_id, idempotency_key: key(), customer: CUSTOMER });
}

const tablesOf = (b: Booking) => [
  b.slot.resource!.id,
  ...(b.slot.additional_resources ?? []).map((r) => r.id),
];

/** Take the three 4-tops, so the next guests can only get the 3-tops. */
async function fillFours(s: BookingService, at = '19:00'): Promise<void> {
  for (let i = 0; i < 3; i++) await holdFor(s, 4, at);
}

const confirm = (s: BookingService, b: Booking) =>
  s.confirm({
    booking_id: b.booking_id,
    idempotency_key: key(),
    user_confirmed: true,
    customer: CUSTOMER,
  });

export function describeTableCombinations(
  name: string,
  makeStore: () => Promise<BookingRecordStore> | BookingRecordStore,
  seeds = 12,
): void {
  describe(`joined tables: ${name}`, () => {
    it('offers one table while any fits and joined tables only when none is free', async () => {
      const { a } = rig(await makeStore(), combinationVenue({ big: true }));
      const [first] = await slotsAt(a, 6);
      // The 8-top fits six, so nothing is joined.
      expect(first!.resource).toMatchObject({ id: 'big' });
      expect(first!.additional_resources).toBeUndefined();
      const held = await a.hold({
        slot_id: first!.slot_id,
        idempotency_key: key(),
        customer: CUSTOMER,
      });
      expect(tablesOf(held)).toEqual(['big']);

      // With the 8-top gone the party is offered joined tables, and the slot says so.
      const [joined] = await slotsAt(a, 6);
      expect(joined!.resource!.label).toBe('Tables P1 and P2 together');
      expect(joined!.additional_resources).toEqual([
        { id: 'p2', kind: 'table', label: 'Table P2' },
      ]);

      // A party that fits a single free table is never offered joined ones.
      const [four] = await slotsAt(a, 4);
      expect(four!.additional_resources).toBeUndefined();
      expect(four!.resource!.id).toBe('f1');
    });

    it('picks the combination that wastes the fewest seats, then the earlier one in the config', async () => {
      const { a } = rig(await makeStore(), combinationVenue());
      // Six guests: 3+3 seats exactly, where 4+4 wastes two, although f1+f2 is listed first.
      const first = await holdFor(a, 6);
      expect(tablesOf(first)).toEqual(['p1', 'p2']);
      // Next best is 4+4; of the two 4+4 pairs the config lists f1+f2 first.
      const second = await holdFor(a, 6);
      expect(tablesOf(second)).toEqual(['f1', 'f2']);
      // f2 is now taken, so f2+f3 is not an option any more: nothing is offered, and a hold is refused.
      expect(await slotsAt(a, 6)).toEqual([]);
      await expect(
        a.hold({ slot_id: first.slot.slot_id, idempotency_key: key(), customer: CUSTOMER }),
      ).rejects.toMatchObject({ code: 'slot_unavailable' });
    });

    it('blocks every joined table for others, and offers nothing a hold would refuse', async () => {
      const { a, b } = rig(await makeStore(), combinationVenue());
      const joined = await holdFor(a, 6); // p1+p2
      const joined2 = await holdFor(b, 8); // f1+f2 (p1+p2 seats at most six)
      expect(tablesOf(joined)).toEqual(['p1', 'p2']);
      expect(tablesOf(joined2)).toEqual(['f1', 'f2']);
      // Of the 4-tops only f3 is free: the first four takes it, the second finds nothing, so
      // f2 (the second table of f1+f2) really is blocked, not just the primary one.
      const four = await holdFor(a, 4);
      expect(tablesOf(four)).toEqual(['f3']);
      expect(await slotsAt(a, 4)).toEqual([]);
      await expect(
        a.hold({ slot_id: four.slot.slot_id, idempotency_key: key(), customer: CUSTOMER }),
      ).rejects.toMatchObject({ code: 'slot_unavailable' });
      // Likewise p2, the joined pair's second 3-top, cannot be taken by two guests.
      expect(await slotsAt(a, 2)).toEqual([]);
    });

    it('never offers a slot that createHold refuses', async () => {
      // Fill the evening bit by bit, at times that overlap each other partly: whatever search
      // offers in the state it is in, a hold of that slot must succeed.
      const { a } = rig(await makeStore(), combinationVenue({ extraBuffer: 15 }));
      const times = ['19:00', '19:30', '20:00', '20:30', '19:00', '19:30'];
      let offered = 0;
      let joined = 0;
      for (let i = 0; i < 40; i++) {
        const party = [6, 4, 8, 2, 5, 3, 7, 4][i % 8]!;
        const at = times[i % times.length]!;
        const [slot] = await slotsAt(a, party, at);
        if (!slot) continue;
        offered++;
        if (slot.additional_resources) joined++;
        await expect(
          a.hold({ slot_id: slot.slot_id, idempotency_key: key(), customer: CUSTOMER }),
          `${party} guests at ${at}, step ${i}`,
        ).resolves.toMatchObject({ status: 'held' });
      }
      expect(offered).toBeGreaterThan(2);
      expect(joined).toBeGreaterThan(0);
    });

    it('keeps all tables through confirm and frees all of them on cancel', async () => {
      const { a, b } = rig(await makeStore(), combinationVenue());
      await fillFours(a);
      const held = await holdFor(a, 6);
      const confirmed = await confirm(a, held);
      expect(tablesOf(confirmed)).toEqual(['p1', 'p2']);
      expect(tablesOf((await b.getBooking(held.booking_id))!)).toEqual(['p1', 'p2']);
      // Still blocking after the confirm: every table is taken, p2 as much as p1.
      expect(await slotsAt(a, 2)).toEqual([]);

      await a.cancel({
        booking_id: held.booking_id,
        idempotency_key: key(),
        user_confirmed: true,
      });
      // Both 3-tops are back (and not just the primary one).
      const one = await holdFor(a, 3);
      const two = await holdFor(b, 3);
      expect(new Set([...tablesOf(one), ...tablesOf(two)])).toEqual(new Set(['p1', 'p2']));
    });

    it('frees all tables when a hold expires', async () => {
      const { a, clock } = rig(await makeStore(), combinationVenue());
      await fillFours(a);
      const held = await holdFor(a, 6);
      expect(await slotsAt(a, 2)).toEqual([]);
      clock.set(new Date(held.expires_at!));
      expect((await a.getBooking(held.booking_id)).status).toBe('expired');
      // The four-tops' holds lapsed at the same instant, so ask for 3-top guests only after
      // taking the fours again.
      await fillFours(a);
      const one = await holdFor(a, 3);
      const two = await holdFor(a, 3);
      expect(new Set([...tablesOf(one), ...tablesOf(two)])).toEqual(new Set(['p1', 'p2']));
    });

    it('moves every table when a confirmed booking is rescheduled', async () => {
      const { a } = rig(await makeStore(), combinationVenue());
      await fillFours(a, '19:00');
      await fillFours(a, '21:00');
      const held = await holdFor(a, 6, '19:00');
      const confirmed = await confirm(a, held);
      const [later] = await slotsAt(a, 6, '21:00');
      const moved = await a.reschedule({
        booking_id: confirmed.booking_id,
        slot_id: later!.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      });
      expect(tablesOf(moved)).toEqual(['p1', 'p2']);
      // The new time is blocked on both tables ...
      expect(await slotsAt(a, 2, '21:00')).toEqual([]);
      // ... and the old time has both back.
      const early = await holdFor(a, 3, '19:00');
      const early2 = await holdFor(a, 3, '19:00');
      expect(new Set([...tablesOf(early), ...tablesOf(early2)])).toEqual(new Set(['p1', 'p2']));
      expect(await a.getBooking(moved.booking_id)).toMatchObject({ status: 'confirmed' });
    });
    it('turns joined tables over later by the extra buffer, and only those', async () => {
      const { a } = rig(await makeStore(), combinationVenue({ extraBuffer: 30 }));
      await holdFor(a, 8); // f1+f2: 19:00-20:30, then 15 minutes turnover and 30 for the tables
      // Singles are tried f1, f2, f3: at 21:00 f1 is still being turned over, so a four gets f3.
      // (With only the venue's 15 minutes f1 would be free again at 20:45.)
      expect((await slotsAt(a, 4, '21:00'))[0]!.resource!.id).toBe('f3');
      // From 21:15 f1 is free again.
      expect((await slotsAt(a, 4, '21:30'))[0]!.resource!.id).toBe('f1');
    });

    it('racing holds never put a table into two bookings', { timeout: FUZZ_TIMEOUT }, async () => {
      await forEachSeed(
        seeds,
        async (rng, seed) => {
          const r = rig(await makeStore(), combinationVenue({ big: seed % 2 === 0 }));
          const parties = Array.from({ length: rng.int(8, 16) }, () =>
            rng.pick([2, 3, 4, 4, 5, 6, 6, 7, 8]),
          );
          const results = await Promise.allSettled(
            parties.map(async (party, i) => {
              await ticks(rng.int(0, 6));
              const svc = i % 2 ? r.a : r.b;
              const slot = (await slotsAt(svc, party)).at(0);
              if (!slot) return undefined;
              await ticks(rng.int(0, 6));
              return svc.hold({
                slot_id: slot.slot_id,
                idempotency_key: `race-${seed}-${i}`,
                customer: CUSTOMER,
              });
            }),
          );
          for (const res of results) {
            if (res.status === 'rejected') {
              expect((res.reason as { code?: string }).code).toBe('slot_unavailable');
            }
          }
          const all = await r.provider.inspectBookings(r.clock.now());
          const live = all.filter((b) => b.status === 'held' || b.status === 'confirmed');
          const taken = live.flatMap((b) => [b.resource_id, ...b.extra_resource_ids]);
          // One table, one booking (they all start together, so every pair overlaps).
          expect(new Set(taken).size, `seed ${seed}: ${taken.join(',')}`).toBe(taken.length);
          expect(await r.provider.findOverlaps(r.clock.now())).toEqual([]);
          // What the slot says matches what the store holds.
          for (const b of live)
            expect(tablesOf(b).sort()).toEqual([b.resource_id, ...b.extra_resource_ids].sort());
        },
        name,
      );
    });

    it('six guests racing for two joined tables: exactly two bookings, never three', async () => {
      const r = rig(await makeStore(), combinationVenue());
      const slot = (await slotsAt(r.a, 6))[0]!;
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? r.a : r.b).hold({
            slot_id: slot.slot_id,
            idempotency_key: `six-guests-${i}`,
            customer: CUSTOMER,
          }),
        ),
      );
      // p1+p2 and one of f1+f2 / f2+f3: all that fits, and each holds both of its tables.
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
      const live = await r.provider.inspectBookings(r.clock.now());
      expect(new Set(live.flatMap((b) => [b.resource_id, ...b.extra_resource_ids])).size).toBe(4);
      expect(live.every((b) => b.extra_resource_ids.length === 1)).toBe(true);
    });
  });
}
