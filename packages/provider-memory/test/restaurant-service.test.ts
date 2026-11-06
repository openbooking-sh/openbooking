import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, isBookingError, type Slot } from '@openbooking-sh/core';
import {
  MemoryBookingProvider,
  MemoryBookingStore,
  demoRestaurantConfig,
  durationFor,
  type OfferingConfig,
  type VenueConfig,
} from '../src';

// Monday 2026-10-12 10:00 Oslo. Wednesday the 14th is a normal service day.
const NOW = '2026-10-12T08:00:00Z';
const DAY = '2026-10-14';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function venue(
  tables: number,
  over: Partial<VenueConfig> = {},
  offering: Partial<OfferingConfig> = {},
): VenueConfig {
  return {
    venue: { id: 'r', name: 'Test Bistro', timezone: 'Europe/Oslo', currency: 'NOK' },
    currency: 'NOK',
    resources: Array.from({ length: tables }, (_, i) => ({
      id: `t${i + 1}`,
      venue_id: 'r',
      kind: 'table',
      name: `Table ${i + 1}`,
      capacity: { min: 1, max: 8 },
      tags: [],
    })),
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
        ...offering,
      },
    ],
    opening_hours: { 3: [{ open: '11:00', close: '24:00' }] },
    slot_interval_minutes: 30,
    buffer_minutes: 15,
    min_lead_minutes: 30,
    max_days_ahead: 30,
    ...over,
  };
}

function setup(cfg: VenueConfig, store = new MemoryBookingStore()) {
  const clock = new ManualClock(NOW);
  const provider = new MemoryBookingProvider({ name: 'Test', venues: [cfg] }, { store });
  const service = new BookingService({ provider, clock });
  const second = new BookingService({
    provider: new MemoryBookingProvider({ name: 'Test', venues: [cfg] }, { store }),
    clock,
  });
  return { service, second, clock };
}

let n = 0;
const key = () => `rs-key-${++n}`;

async function search(
  service: BookingService,
  party: number,
  extra: { from?: string; to?: string } = {},
) {
  const { slots } = await service.searchAvailability({
    date: DAY,
    party_size: { total: party },
    offering_id: 'dinner',
    ...(extra.from ? { time_from: extra.from } : {}),
    ...(extra.to ? { time_to: extra.to } : {}),
  });
  return slots;
}

const starts = (slots: Slot[]) => slots.map((s) => s.start.slice(11, 16));

async function slotAt(service: BookingService, party: number, at: string): Promise<Slot> {
  const slot = (await search(service, party, { from: at, to: at }))[0];
  if (!slot) throw new Error(`no slot for ${party} at ${at}`);
  return slot;
}

const hold = (service: BookingService, slot: Slot) =>
  service.hold({ slot_id: slot.slot_id, idempotency_key: key() });

async function book(service: BookingService, party: number, at: string) {
  const held = await hold(service, await slotAt(service, party, at));
  return service.confirm({
    booking_id: held.booking_id,
    idempotency_key: key(),
    user_confirmed: true,
    customer: CUSTOMER,
  });
}

const BY_PARTY = [
  { min_party_size: 1, duration_minutes: 90 },
  { min_party_size: 6, duration_minutes: 150 },
];

describe('table time by party size', () => {
  it('picks the entry with the largest min_party_size that fits, else the default', () => {
    const o = venue(
      1,
      {},
      {
        duration_minutes: 100,
        duration_by_party: [BY_PARTY[1]!, { min_party_size: 3, duration_minutes: 120 }],
      },
    ).offerings[0]!;
    expect(durationFor(o, 2)).toBe(100); // smaller than every entry: the default
    expect(durationFor(o, 3)).toBe(120);
    expect(durationFor(o, 5)).toBe(120);
    expect(durationFor(o, 6)).toBe(150);
    expect(durationFor(o, 8)).toBe(150);
  });

  it('shows the party-specific end in availability and on the hold', async () => {
    const { service } = setup(venue(1, {}, { duration_by_party: BY_PARTY }));
    const two = await slotAt(service, 2, '18:00');
    const six = await slotAt(service, 6, '18:00');
    expect(two.end).toBe(`${DAY}T19:30:00+02:00`);
    expect(six.end).toBe(`${DAY}T20:30:00+02:00`);
    expect((await hold(service, six)).slot.end).toBe(`${DAY}T20:30:00+02:00`);
  });

  it('blocks the table for the party’s time, so later slots depend on party size', async () => {
    const small = setup(venue(1, {}, { duration_by_party: BY_PARTY }));
    await book(small.service, 2, '18:00'); // table busy until 19:45 with the buffer
    const afterSmall = starts(await search(small.service, 2, { from: '19:00', to: '20:30' }));
    expect(afterSmall).toEqual(['20:00', '20:30']);

    const big = setup(venue(1, {}, { duration_by_party: BY_PARTY }));
    await book(big.service, 6, '18:00'); // busy until 20:45
    const afterBig = starts(await search(big.service, 2, { from: '19:00', to: '21:00' }));
    expect(afterBig).toEqual(['21:00']);
  });

  it('refuses a hold from an earlier search once a longer booking took the table', async () => {
    const { service } = setup(venue(1, {}, { duration_by_party: BY_PARTY }));
    const stale = await slotAt(service, 2, '19:30'); // free while the table is empty
    await book(service, 6, '18:00'); // now busy until 20:45
    await expect(hold(service, stale)).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('does not offer a start whose party-specific time would pass closing', async () => {
    const cfg = venue(
      1,
      { opening_hours: { 3: [{ open: '17:00', close: '22:00' }] } },
      { duration_by_party: BY_PARTY },
    );
    const { service } = setup(cfg);
    expect(starts(await search(service, 2, { from: '20:00' }))).toEqual(['20:00', '20:30']);
    // 19:30 + 2.5 h ends exactly at closing; 20:00 would not.
    expect(starts(await search(service, 6, { from: '19:00' }))).toEqual(['19:00', '19:30']);
  });

  it('reschedules with the party’s time', async () => {
    const { service } = setup(venue(2, {}, { duration_by_party: BY_PARTY }));
    const booking = await book(service, 6, '18:00');
    const target = await slotAt(service, 6, '19:00');
    const moved = await service.reschedule({
      booking_id: booking.booking_id,
      slot_id: target.slot_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    expect(moved.slot.start).toBe(`${DAY}T19:00:00+02:00`);
    expect(moved.slot.end).toBe(`${DAY}T21:30:00+02:00`);
    // The moved booking holds its table until 21:45; with the other table taken too, a two-top
    // can only start once they are free.
    await book(service, 6, '19:00');
    expect(starts(await search(service, 2, { from: '21:00', to: '22:00' }))).toEqual(['22:00']);
  });

  it('is unchanged without duration_by_party', async () => {
    const { service } = setup(venue(1));
    expect((await slotAt(service, 6, '18:00')).end).toBe(`${DAY}T19:30:00+02:00`);
  });

  it('rejects a bad table time at startup', () => {
    expect(
      () =>
        new MemoryBookingProvider({
          name: 'x',
          venues: [
            venue(1, {}, { duration_by_party: [{ min_party_size: 0, duration_minutes: 60 }] }),
          ],
        }),
    ).toThrow(/min_party_size/);
  });
});

describe('pacing', () => {
  // Cap of 6 guests per hour, 8 tables: only pacing can stop a booking.
  const paced = () => venue(8, { pacing: { max_guests_per_interval: 6, interval_minutes: 60 } });

  it('stops holds that would exceed the cap and says what to do', async () => {
    const { service } = setup(paced());
    const wanted = await slotAt(service, 2, '18:30');
    await book(service, 4, '18:00');
    await book(service, 2, '18:30'); // 6 guests in the 18:00 hour
    const error = await hold(service, wanted).catch((e: unknown) => e);
    expect(isBookingError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'slot_unavailable' });
    expect((error as { suggested_next_action?: string }).suggested_next_action).toMatch(
      /earlier or later/,
    );
  });

  it('never offers a start that createHold would refuse for pacing', async () => {
    const { service } = setup(paced());
    await book(service, 4, '18:00');
    const hour = starts(await search(service, 4, { from: '18:00', to: '19:30' }));
    expect(hour).toEqual(['19:00', '19:30']); // 4 + 4 > 6 inside the 18:00 hour
    expect(starts(await search(service, 2, { from: '18:00', to: '19:30' }))).toEqual([
      '18:00',
      '18:30',
      '19:00',
      '19:30',
    ]);
    // Every offered slot is holdable (each on its own, as they share the cap).
    for (const slot of await search(service, 2, { from: '18:00', to: '19:30' })) {
      const fresh = setup(paced());
      await book(fresh.service, 4, '18:00');
      await hold(fresh.service, slot);
    }
  });

  it('holds under concurrent calls from two server instances', async () => {
    const { service, second } = setup(paced());
    const slots = [await slotAt(service, 2, '18:00'), await slotAt(service, 2, '18:30')];
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        hold(i % 2 ? service : second, slots[i % 2 === 0 ? 0 : 1]!),
      ),
    );
    // 6 guests per hour, 2 per party: exactly 3 holds, never more.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'slot_unavailable' });
    }
  });

  it('frees the cap when a hold expires', async () => {
    const { service, clock } = setup(paced());
    await hold(service, await slotAt(service, 4, '18:00'));
    await hold(service, await slotAt(service, 2, '18:30'));
    expect(starts(await search(service, 2, { from: '18:00', to: '18:30' }))).toEqual([]);
    clock.advanceSeconds(service.holdTtlSeconds + 1);
    expect(starts(await search(service, 2, { from: '18:00', to: '18:30' }))).toEqual([
      '18:00',
      '18:30',
    ]);
    await hold(service, await slotAt(service, 2, '18:00'));
  });

  it('counts the default 15 minute window', async () => {
    // Slots are 30 minutes apart, so with the default window each start has its own cap.
    const { service } = setup(venue(8, { pacing: { max_guests_per_interval: 4 } }));
    await book(service, 4, '18:00');
    expect(starts(await search(service, 2, { from: '18:00', to: '18:30' }))).toEqual(['18:30']);
  });

  it('applies to rescheduling', async () => {
    const { service } = setup(paced());
    const mine = await book(service, 2, '17:00');
    await book(service, 4, '18:00');
    await book(service, 2, '18:30');
    // A target found before the hour filled up.
    const open = setup(paced());
    const target = await slotAt(open.service, 2, '19:00');
    await book(service, 4, '19:00');
    await book(service, 2, '19:30');
    await expect(
      service.reschedule({
        booking_id: mine.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });
});

describe('service periods, seatings and the walk-in reserve', () => {
  const periods = (extra: Partial<VenueConfig> = {}) =>
    venue(8, {
      service_periods: [
        { name: 'Lunch', open: '11:30', close: '14:00', seatings: ['12:00', '13:15'] },
        { name: 'Dinner', open: '17:00', close: '22:00', weekdays: [3] },
      ],
      ...extra,
    });

  it('offers only the seatings of a period, and grid starts where there are none', async () => {
    const { service } = setup(periods());
    const slots = starts(await search(service, 2));
    expect(slots).toEqual([
      '12:00',
      '13:15', // not on the 30 minute grid
      '17:00',
      '17:30',
      '18:00',
      '18:30',
      '19:00',
      '19:30',
      '20:00',
      '20:30',
      '21:00',
      '21:30',
    ]);
    // A seating can be held, and a time between seatings cannot.
    await hold(service, await slotAt(service, 2, '13:15'));
  });

  it('refuses a made-up start outside the periods', async () => {
    const { service } = setup(periods());
    const real = await slotAt(service, 2, '12:00');
    const forged = `slot_${Buffer.from(
      JSON.stringify({ v: 'r', o: 'dinner', s: '2026-10-14T10:30:00.000Z', p: 2 }),
    ).toString('base64url')}`;
    expect(real.slot_id).not.toBe(forged);
    await expect(service.hold({ slot_id: forged, idempotency_key: key() })).rejects.toMatchObject({
      code: 'slot_unavailable',
    });
  });

  it('leaves a venue without service periods on the slot grid', async () => {
    const { service } = setup(venue(8));
    expect(starts(await search(service, 2, { from: '11:00', to: '12:30' }))).toEqual([
      '11:00',
      '11:30',
      '12:00',
      '12:30',
    ]);
  });

  it('holds back covers for walk-ins', async () => {
    const cfg = venue(8, {
      service_periods: [
        { name: 'Lunch', open: '11:30', close: '14:00', max_online_guests: 8 },
        { name: 'Dinner', open: '17:00', close: '22:00' },
      ],
    });
    const { service } = setup(cfg);
    await book(service, 4, '12:00');
    await book(service, 4, '13:00');
    // Lunch is full online even though tables are free; dinner is untouched.
    const all = starts(await search(service, 2));
    expect(all.some((s) => s < '14:00')).toBe(false);
    expect(all).toContain('17:00');
  });

  it('explains a full walk-in reserve when a stale slot is held', async () => {
    const cfg = venue(8, {
      service_periods: [{ name: 'Lunch', open: '11:30', close: '14:00', max_online_guests: 6 }],
    });
    const { service } = setup(cfg);
    const stale = await slotAt(service, 4, '13:00');
    await book(service, 4, '12:00');
    const error = await hold(service, stale).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'slot_unavailable' });
    expect((error as { message: string }).message).toMatch(/Lunch/);
    expect((error as { suggested_next_action?: string }).suggested_next_action).toMatch(/walk-ins/);
  });

  it('lets a period override the venue pacing', async () => {
    const cfg = venue(8, {
      pacing: { max_guests_per_interval: 100, interval_minutes: 60 },
      service_periods: [
        { name: 'Lunch', open: '11:30', close: '14:00', max_guests_per_interval: 4 },
        { name: 'Dinner', open: '17:00', close: '22:00' },
      ],
    });
    const { service } = setup(cfg);
    await book(service, 4, '12:00');
    // 12:30 shares the 12:00 hour and its cap of 4; 13:00 is a new hour.
    expect(starts(await search(service, 2, { from: '12:00', to: '13:00' }))).toEqual(['13:00']);
    await book(service, 4, '17:00');
    await book(service, 4, '17:30'); // dinner uses the venue's roomy cap
  });

  it('rejects bad service periods at startup', () => {
    const bad = venue(1, { service_periods: [{ name: 'Lunch', open: '11:30', close: 'noon' }] });
    expect(() => new MemoryBookingProvider({ name: 'x', venues: [bad] })).toThrow(/HH:mm/);
    const zero = venue(1, { pacing: { max_guests_per_interval: 0 } });
    expect(() => new MemoryBookingProvider({ name: 'x', venues: [zero] })).toThrow(/pacing/);
  });
});

describe('existing configs', () => {
  it('the demo restaurant keeps its slots and table times', async () => {
    const provider = new MemoryBookingProvider(demoRestaurantConfig());
    const service = new BookingService({ provider, clock: new ManualClock(NOW) });
    const { slots } = await service.searchAvailability({
      venue_id: 'demo-bistro',
      date: DAY,
      party_size: { total: 2 },
      offering_id: 'dinner',
    });
    expect(starts(slots)[0]).toBe('17:00');
    expect(slots[0]!.end).toBe(`${DAY}T18:30:00+02:00`);
    expect(starts(slots)).toContain('20:30');
  });
});
