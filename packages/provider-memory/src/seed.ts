import type { Resource } from '@openbooking-sh/core';
import type { MemoryProviderConfig, VenueConfig } from './config';

const VENUE_ID = 'demo-bistro';

const table = (id: string, min: number, max: number, tags: string[] = []): Resource => ({
  id,
  venue_id: VENUE_ID,
  kind: 'table',
  name: `Table ${id.toUpperCase()}`,
  capacity: { min, max },
  tags,
});

/**
 * A fictional restaurant used by the demo, tests and benchmark.
 *
 * - Open Tue–Thu 17–22, Fri–Sat 17–23, Sun 16–21, closed Monday. Europe/Oslo, NOK.
 * - 12 tables (2-, 4-, 6- and 8-tops; window, outdoor and private-room tags).
 * - "Dinner" (90 min, pay at venue): free cancellation until 24h before, then 200 NOK per guest.
 *   Parties of 6+ pay a 200 NOK/guest deposit at confirmation.
 * - "Chef's tasting menu" (150 min, Fri–Sat, 1195 NOK/guest): 500 NOK/guest deposit at
 *   confirmation, free cancellation until 48h before, then the deposit is retained.
 */
export function demoRestaurantVenue(): VenueConfig {
  return {
    venue: {
      id: VENUE_ID,
      name: 'Demo Bistro Oslo',
      timezone: 'Europe/Oslo',
      currency: 'NOK',
      address: {
        street_address: 'Eksempelgata 1',
        address_locality: 'Oslo',
        postal_code: '0150',
        address_country: 'NO',
      },
      phone_number: '+4700000000',
      description: 'Fictional neighbourhood bistro used for OpenBooking demos.',
    },
    currency: 'NOK',
    resources: [
      table('t1', 1, 2, ['window']),
      table('t2', 1, 2, ['window']),
      table('t3', 1, 2),
      table('t4', 1, 2),
      table('t5', 1, 2),
      table('t6', 2, 4),
      table('t7', 2, 4),
      table('t8', 2, 4, ['window']),
      table('t9', 2, 4, ['outdoor']),
      table('t10', 4, 6),
      table('t11', 4, 6, ['outdoor']),
      table('t12', 5, 8, ['private_room']),
    ],
    offerings: [
      {
        id: 'dinner',
        venue_id: VENUE_ID,
        name: 'Dinner',
        description: 'À la carte dinner. Table is yours for 90 minutes.',
        duration_minutes: 90,
        price_per_person: null,
        resource_kinds: ['table'],
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: 24,
          late_fee_per_person: 20000,
          no_show_fee_per_person: 20000,
        },
        deposit: { min_party_size: 6, amount_per_person: 20000, due: 'at_confirmation' },
      },
      {
        id: 'tasting',
        venue_id: VENUE_ID,
        name: "Chef's tasting menu",
        description: 'Seven-course tasting menu, about 2.5 hours.',
        duration_minutes: 150,
        price_per_person: { amount: 119500, currency: 'NOK' },
        resource_kinds: ['table'],
        weekdays: [5, 6],
        first_start: '18:00',
        last_start: '20:00',
        cancellation: {
          refundability: 'partially_refundable',
          free_until_hours_before: 48,
          late_fee_per_person: 50000,
          no_show_fee_per_person: 119500,
        },
        deposit: { min_party_size: 1, amount_per_person: 50000, due: 'at_confirmation' },
      },
    ],
    opening_hours: {
      0: [{ open: '16:00', close: '21:00' }],
      2: [{ open: '17:00', close: '22:00' }],
      3: [{ open: '17:00', close: '22:00' }],
      4: [{ open: '17:00', close: '22:00' }],
      5: [{ open: '17:00', close: '23:00' }],
      6: [{ open: '17:00', close: '23:00' }],
    },
    closed_dates: ['2026-12-24', '2026-12-25', '2026-12-31'],
    slot_interval_minutes: 30,
    buffer_minutes: 15,
    min_lead_minutes: 30,
    max_days_ahead: 90,
  };
}

export function demoRestaurantConfig(): MemoryProviderConfig {
  return {
    name: 'Demo Bistro Oslo',
    description: 'In-memory demo restaurant for OpenBooking.',
    venues: [demoRestaurantVenue()],
  };
}
