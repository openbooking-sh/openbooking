import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, type BookingError } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '../src';

// Thursday 2026-10-01 08:00 Oslo time.
const NOW = '2026-10-01T06:00:00Z';
const FRIDAY = '2026-10-02';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup() {
  const clock = new ManualClock(NOW);
  const provider = createDemoSalonProvider();
  return { service: new BookingService({ provider, clock }), provider, clock };
}

let n = 0;
const key = () => `salon-key-${++n}`;

describe('demo salon (Studio Nord)', () => {
  it('offers services with prices and names the stylist', async () => {
    const { service } = setup();
    const { venue, slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '15:00',
      time_to: '15:00',
    });
    expect(venue.name).toBe('Studio Nord');
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      start: '2026-10-02T15:00:00+02:00',
      end: '2026-10-02T15:45:00+02:00',
      offering: { id: 'haircut', name: 'Haircut' },
      price: { amount: 65000, currency: 'NOK' },
      resource: { kind: 'staff', label: 'Maria' },
      deposit: null,
    });
  });

  it('lets the customer ask for a specific stylist', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 1 },
      offering_id: 'beard-trim',
      time_from: '11:00',
      time_to: '11:00',
      tags: ['jonas'],
    });
    expect(slots[0]!.resource?.label).toBe('Jonas');
  });

  it('requires a deposit for color & cut', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: FRIDAY,
      party_size: { total: 1 },
      offering_id: 'color-cut',
      time_from: '13:00',
      time_to: '13:00',
    });
    expect(slots[0]!.deposit).toMatchObject({ amount: { amount: 30000 }, due: 'at_confirmation' });
  });

  it('never double-books a stylist and falls back to the next one', async () => {
    const { service, provider, clock } = setup();
    const q = {
      date: FRIDAY,
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '15:00',
      time_to: '15:00',
    };
    const labels: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { slots } = await service.searchAvailability(q);
      const hold = await service.hold({
        slot_id: slots[0]!.slot_id,
        idempotency_key: key(),
        customer: CUSTOMER,
      });
      labels.push(hold.slot.resource!.label);
    }
    expect(labels.sort()).toEqual(['Aisha', 'Jonas', 'Maria']);
    expect((await service.searchAvailability(q)).slots).toEqual([]);
    expect(await provider.findOverlaps(clock.now())).toEqual([]);
  });

  it('is closed on Sundays and Mondays', async () => {
    const { service } = setup();
    for (const date of ['2026-10-04', '2026-10-05']) {
      const { slots } = await service.searchAvailability({ date, party_size: { total: 1 } });
      expect(slots).toEqual([]);
    }
  });

  it('rejects group bookings for one-person services', async () => {
    const { service } = setup();
    const err = (await service
      .searchAvailability({ date: FRIDAY, party_size: { total: 3 } })
      .catch((e: unknown) => e)) as BookingError;
    expect(err.code).toBe('party_size_unsupported');
  });
});
