import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, runAsActor } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { describeGuardStore } from '../../core/test/guard-store-contract';
import { PostgresGuardStore, postgresStores, type Db } from '../src';
import { freshDb, target } from './helpers';

describeGuardStore(`postgres (${target})`, async () => new PostgresGuardStore(await freshDb()));

const NOW = '2026-10-01T06:00:00Z';
const SEARCH = { date: '2026-10-02', party_size: { total: 1 }, offering_id: 'haircut', limit: 50 };

/** Slots an hour apart, so one customer's bookings never overlap each other. */
function spaced<T extends { start: string }>(slots: T[]): T[] {
  return slots.filter((s) => new Date(s.start).getMinutes() === 0);
}

function boot(db: Db, clock: ManualClock) {
  const stores = postgresStores(db, { idempotency: { now: () => clock.now().getTime() } });
  const service = new BookingService({
    provider: createDemoSalonProvider({ store: stores.bookings }),
    clock,
    idempotencyStore: stores.idempotency,
    guard: { store: stores.guard, salt: 'test', guest: { maxActive: 2 }, agent: { maxHolds: 3 } },
  });
  return service;
}

describe(`anti-scalping on postgres (${target})`, () => {
  it('holds the per-guest limit across instances racing on one database', async () => {
    const db = await freshDb();
    const clock = new ManualClock(NOW);
    const a = boot(db, clock);
    const b = boot(db, clock);
    const { slots } = await a.searchAvailability({
      ...SEARCH,
      time_from: '09:00',
      time_to: '18:00',
    });
    expect(spaced(slots).length).toBeGreaterThanOrEqual(8);
    const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

    const results = await Promise.allSettled(
      spaced(slots)
        .slice(0, 8)
        .map((s, i) =>
          (i % 2 ? a : b).hold({
            slot_id: s.slot_id,
            idempotency_key: `race-${i}-key`,
            customer,
          }),
        ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).not.toHaveLength(0);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'booking_limit_reached' });
    }
    // Refused holds were handed back: only the two live ones block the calendar.
    const live = (await a.listBookings({ status: ['held'] })).length;
    expect(live).toBe(2);
  });

  it('holds the per-agent hold limit across instances, and lets go when a hold lapses', async () => {
    const db = await freshDb();
    const clock = new ManualClock(NOW);
    const a = boot(db, clock);
    const b = boot(db, clock);
    const { slots } = await a.searchAvailability({
      ...SEARCH,
      time_from: '09:00',
      time_to: '18:00',
    });
    const bot = { protocol: 'mcp' as const, agent: 'Bot', client: 'scalper-bot' };
    const hold = (svc: BookingService, i: number) =>
      runAsActor(bot, () =>
        svc.hold({ slot_id: spaced(slots)[i]!.slot_id, idempotency_key: `bot-hold-${i}` }),
      );
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => hold(i % 2 ? a : b, i)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);

    clock.advance(a.holdTtlSeconds * 1000 + 1);
    await expect(hold(a, 6)).resolves.toMatchObject({ status: 'held' });
  });
});
