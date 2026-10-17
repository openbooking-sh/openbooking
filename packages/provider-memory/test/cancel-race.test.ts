import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, type BookingProvider } from '@openbooking-sh/core';
import { createDemoRestaurantProvider } from '../src';

const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

/**
 * Releasing a hold needs no consent, so it must only ever release a hold. If the customer
 * confirmed in the meantime, the release has to lose: otherwise a booking the user approved (and
 * was told is confirmed) is cancelled without their say-so and without applying the policy.
 */
describe('releasing a hold while it is being confirmed', () => {
  it('never cancels a booking that was confirmed after the release looked at it', async () => {
    const inner = createDemoRestaurantProvider();
    let atGate!: () => void;
    const reachedGate = new Promise<void>((resolve) => (atGate = resolve));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));

    // The release has read the booking as "held" and is about to write when the confirm lands.
    const provider: BookingProvider = {
      info: inner.info,
      listVenues: () => inner.listVenues(),
      searchAvailability: (q, ctx) => inner.searchAvailability(q, ctx),
      createHold: (r, ctx) => inner.createHold(r, ctx),
      confirmHold: (r, ctx) => inner.confirmHold(r, ctx),
      getBooking: (id, ctx) => inner.getBooking(id, ctx),
      cancelBooking: async (r, ctx) => {
        atGate();
        await gate;
        return inner.cancelBooking(r, ctx);
      },
    };
    const clock = new ManualClock('2026-10-01T06:00:00Z');
    const service = new BookingService({ provider, clock });

    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 2 },
      offering_id: 'dinner',
    });
    const hold = await service.hold({
      slot_id: slots[0]!.slot_id,
      idempotency_key: 'hold-race-1',
      customer: CUSTOMER,
    });

    const release = service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: 'cancel-race-1',
    });
    const settled = release.then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await reachedGate;
    const confirmed = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-race-1',
      user_confirmed: true,
      customer: CUSTOMER,
    });
    expect(confirmed.status).toBe('confirmed');
    openGate();
    await settled;

    expect((await service.getBooking(hold.booking_id)).status).toBe('confirmed');
  });
});
