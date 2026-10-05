import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, type BookingError } from '@openbooking-sh/core';
import { createDemoRestaurantProvider } from '../src';

// Thursday 2026-10-01 10:00 Oslo time.
const NOW = '2026-10-01T08:00:00Z';
const FRIDAY = '2026-10-02';
const MONDAY = '2026-10-05';
const CUSTOMER = { first_name: 'Grace', last_name: 'Hopper', phone_number: '+4791234567' };

function setup() {
  const clock = new ManualClock(NOW);
  const provider = createDemoRestaurantProvider();
  const service = new BookingService({ provider, clock, holdTtlSeconds: 300 });
  return { clock, provider, service };
}

let n = 0;
const key = () => `test-key-${++n}-${Math.random().toString(36).slice(2)}`;

describe('MemoryBookingProvider (demo restaurant)', () => {
  it('returns slots within opening hours with policy and local offsets', async () => {
    const { service } = setup();
    const { venue, slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 2 },
      offering_id: 'dinner',
      limit: 50,
    });
    expect(venue.name).toBe('Demo Bistro Oslo');
    expect(slots[0]!.start).toBe('2026-10-02T17:00:00+02:00');
    // Dinner is 90 min and must end by 23:00 → last start 21:30.
    expect(slots.at(-1)!.start).toBe('2026-10-02T21:30:00+02:00');
    expect(slots[0]!.cancellation_policy).toMatchObject({
      refundability: 'refundable',
      free_cancellation_until: '2026-10-01T17:00:00+02:00',
      late_cancellation_fee: { amount: 40000, currency: 'NOK' },
    });
    expect(slots[0]!.deposit).toBeNull();
  });

  it('is closed on Mondays and returns nothing', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({ date: MONDAY, party_size: { total: 2 } });
    expect(slots).toEqual([]);
  });

  it('filters by time window and tags', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 4 },
      time_from: '19:00',
      time_to: '20:00',
      tags: ['outdoor'],
      offering_id: 'dinner',
    });
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(['19:00', '19:30', '20:00']);
    expect(slots.every((s) => s.resource?.tags.includes('outdoor'))).toBe(true);
  });

  it('requires a deposit for parties of 6+ and for the tasting menu', async () => {
    const { service } = setup();
    const big = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 6 },
      offering_id: 'dinner',
    });
    expect(big.slots[0]!.deposit).toMatchObject({
      amount: { amount: 120000 },
      due: 'at_confirmation',
    });
    const tasting = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 2 },
      offering_id: 'tasting',
    });
    expect(tasting.slots[0]!.start.slice(11, 16)).toBe('18:00');
    expect(tasting.slots[0]!.price).toEqual({ amount: 239000, currency: 'NOK' });
  });

  it('rejects party sizes larger than any table with an actionable error', async () => {
    const { service } = setup();
    const err = (await service
      .searchAvailability({ date: FRIDAY, party_size: { total: 12 } })
      .catch((e: unknown) => e)) as BookingError;
    expect(err.code).toBe('party_size_unsupported');
    expect(err.suggested_next_action).toContain('+4700000000');
  });

  it('never double-books: the 8-top can be held only once per time', async () => {
    const { service, provider, clock } = setup();
    const { slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 8 },
      time_from: '19:00',
      time_to: '19:00',
    });
    const slot = slots[0]!;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.hold({ slot_id: slot.slot_id, idempotency_key: key() }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected.every((r) => (r.reason as BookingError).code === 'slot_unavailable')).toBe(
      true,
    );
    expect(await provider.findOverlaps(clock.now())).toEqual([]);

    // Overlapping later start (19:30) also can't use the only 8-top.
    const later = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 8 },
      time_from: '19:30',
      time_to: '20:30',
    });
    expect(later.slots).toEqual([]);
  });

  it('runs the full lifecycle with a deposit', async () => {
    const { service, clock } = setup();
    const { slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 2 },
      offering_id: 'tasting',
    });
    const hold = await service.hold({
      slot_id: slots[0]!.slot_id,
      idempotency_key: key(),
      customer: CUSTOMER,
    });
    expect(hold.payment.status).toBe('pending');

    const declined = (await service
      .confirm({
        booking_id: hold.booking_id,
        idempotency_key: key(),
        user_confirmed: true,
        payment_token: 'tok_fail_card',
      })
      .catch((e: unknown) => e)) as BookingError;
    expect(declined.code).toBe('payment_failed');

    const confirmed = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
      payment_token: 'tok_visa',
    });
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      payment: { status: 'paid', amount: { amount: 100000 } },
    });

    // 30h before start: inside the 48h window → deposit (500/guest) retained as fee.
    clock.set('2026-10-01T10:00:00Z');
    const { booking } = await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    expect(booking.cancellation).toMatchObject({
      fee: { amount: 100000, currency: 'NOK' },
      refund: { amount: 0, currency: 'NOK' },
    });
  });

  it('releases an expired hold so others can book it', async () => {
    const { service, clock } = setup();
    const q = {
      date: FRIDAY,
      party_size: { total: 8 },
      time_from: '19:00',
      time_to: '19:00',
      offering_id: 'dinner',
    };
    const slot = (await service.searchAvailability(q)).slots[0]!;
    const hold = await service.hold({ slot_id: slot.slot_id, idempotency_key: key() });
    expect((await service.searchAvailability(q)).slots).toEqual([]);
    clock.advanceSeconds(301);
    expect((await service.getBooking(hold.booking_id)).status).toBe('expired');
    expect((await service.searchAvailability(q)).slots).toHaveLength(1);
  });

  it('rejects tampered slot ids', async () => {
    const { service } = setup();
    const err = (await service
      .hold({ slot_id: 'slot_garbage', idempotency_key: key() })
      .catch((e: unknown) => e)) as BookingError;
    expect(err.code).toBe('validation_error');
  });

  it('does not offer slots inside the minimum lead time', async () => {
    const { service, clock } = setup();
    clock.set('2026-10-02T17:10:00Z'); // 19:10 local Friday
    const { slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 2 },
      offering_id: 'dinner',
    });
    expect(slots[0]!.start).toBe('2026-10-02T20:00:00+02:00');
  });
});
