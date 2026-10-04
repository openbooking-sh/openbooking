/**
 * The demo salon on Postgres through the real engine: bookings, idempotent replays and Studio
 * attribution survive a "restart" (fresh provider + service on the same database).
 */
import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking/core';
import { createDemoSalonProvider } from '@openbooking/provider-memory';
import { postgresStores, type Db } from '../src';
import { freshDb, target } from './helpers';

// Thursday 2026-10-01 08:00 Oslo time.
const NOW = '2026-10-01T06:00:00Z';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const SEARCH = {
  date: '2026-10-02',
  party_size: { total: 1 },
  offering_id: 'haircut',
  time_from: '15:00',
  time_to: '15:00',
};

function boot(db: Db, clock: ManualClock) {
  const stores = postgresStores(db, { idempotency: { now: () => clock.now().getTime() } });
  const provider = createDemoSalonProvider({ store: stores.bookings });
  const service = new BookingService({ provider, clock, idempotencyStore: stores.idempotency });
  return { service, provider, stores };
}

describe(`demo salon on postgres (${target})`, () => {
  it('keeps bookings and idempotent replays across a restart', async () => {
    const db = await freshDb();
    const clock = new ManualClock(NOW);
    const first = boot(db, clock);

    const { slots } = await first.service.searchAvailability(SEARCH);
    const hold = await first.service.hold({
      slot_id: slots[0]!.slot_id,
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    const confirmed = await first.service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    });
    expect(confirmed.status).toBe('confirmed');

    // "Restart": nothing shared but the database.
    const second = boot(db, clock);
    expect((await second.service.getBooking(hold.booking_id)).status).toBe('confirmed');
    const replay = await second.service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    });
    expect(replay.confirmation_code).toBe(confirmed.confirmation_code);
    const listed = await second.service.listBookings({ status: ['confirmed'] });
    expect(listed.map((b) => b.booking_id)).toEqual([hold.booking_id]);
  });

  it('never double-books under concurrent holds, and holds lapse on time', async () => {
    const db = await freshDb();
    const clock = new ManualClock(NOW);
    // Two "instances" racing on one database.
    const a = boot(db, clock);
    const b = boot(db, clock);
    const { slots } = await a.service.searchAvailability(SEARCH);
    const slotId = slots[0]!.slot_id;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? a : b).service.hold({ slot_id: slotId, idempotency_key: `race-key-${i}` }),
      ),
    );
    const held = results.filter((r) => r.status === 'fulfilled');
    // Studio Nord has three stylists who do haircuts at 15:00.
    expect(held).toHaveLength(3);
    expect(await a.provider.findOverlaps(clock.now())).toEqual([]);
    expect((await b.service.searchAvailability(SEARCH)).slots).toEqual([]);

    clock.advance(a.service.holdTtlSeconds * 1000 + 1);
    expect((await b.service.searchAvailability(SEARCH)).slots).toHaveLength(1);
    const statuses = (await a.service.listBookings({})).map((x) => x.status);
    expect(statuses).toEqual(['expired', 'expired', 'expired']);
  });
});
