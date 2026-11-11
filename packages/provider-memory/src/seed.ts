import type { Resource } from '@openbooking-sh/core';
import type { MemoryProviderConfig, VenueConfig } from './config';

const VENUE_ID = 'demo-bistro';

const LUNCH = { open: '11:30', close: '15:00' };

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
 * - Open Tue–Sat for lunch (11:30–15:00), dinner Tue–Thu 17–22 and Fri–Sat 17–23, Sun 16–21, closed
 *   Monday. Europe/Oslo, NOK.
 * - 12 tables (2-, 4-, 6- and 8-tops; window, outdoor and private-room tags). Tables 6 and 7 (two
 *   4-tops) can be pushed together for parties of 5 to 8, but only when no single table is free.
 * - Service periods: lunch has two seatings (12:00 and 13:15), dinner starts on the half hour, and
 *   Sunday supper takes at most 24 guests online (the rest is held for walk-ins). At most 20
 *   guests may arrive in the same 15 minutes.
 * - "Dinner" (90 min, pay at venue): table time is 2 h from 5 guests and 2.5 h from 7. Free
 *   cancellation until 24h before, then 200 NOK per guest. Parties of 6+ pay a 200 NOK/guest
 *   deposit at confirmation.
 * - "Lunch" (75 min, Tue–Sat): free cancellation until 4h before.
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
      knowledge: {
        cuisine: ['Modern Nordic', 'Bistro'],
        about:
          'A small neighbourhood bistro with a short seasonal menu and a tasting menu on Fridays and Saturdays.',
        menu: {
          url: 'https://example.com/demo-bistro/menu',
          items: [
            {
              name: 'Beetroot and goat cheese salad',
              description: 'Roasted beetroot, hazelnuts, pickled shallot.',
              price: { amount: 14500, currency: 'NOK' },
              dietary: ['vegetarian'],
            },
            {
              name: 'Pan-fried cod',
              description: 'Cod, brown butter, new potatoes, seasonal greens.',
              price: { amount: 28500, currency: 'NOK' },
              dietary: ['pescatarian'],
            },
            {
              name: 'Celeriac steak',
              description: 'Slow-roasted celeriac, mushroom jus, herb oil.',
              price: { amount: 24500, currency: 'NOK' },
              dietary: ['vegetarian', 'vegan'],
            },
          ],
        },
        dietary: {
          options: ['vegetarian', 'vegan', 'gluten_free'],
          notes: 'Vegan and gluten-free versions of most dishes on request; tell us when you book.',
        },
        atmosphere: 'Relaxed and candle-lit, with music at a low volume. Outdoor tables in summer.',
        accessibility: {
          features: ['step_free_entrance', 'accessible_toilet'],
          notes: 'The private room is up one flight of stairs.',
        },
        parking:
          'No parking at the restaurant. Public car park two minutes away on Eksempelgata 12.',
        dress_code: 'Casual',
        languages: ['nb', 'en'],
        children: 'Children are welcome. High chairs and a kids menu are available.',
      },
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
        description:
          'À la carte dinner. Table is yours for 90 minutes (2 hours from 5 guests, 2.5 hours from 7).',
        duration_minutes: 90,
        duration_by_party: [
          { min_party_size: 1, duration_minutes: 90 },
          { min_party_size: 5, duration_minutes: 120 },
          { min_party_size: 7, duration_minutes: 150 },
        ],
        // Keeps lunch starts out of the afternoon and dinner starts out of lunch.
        first_start: '16:00',
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
        id: 'lunch',
        venue_id: VENUE_ID,
        name: 'Lunch',
        description: 'Set lunch or à la carte. Table is yours for 75 minutes.',
        duration_minutes: 75,
        price_per_person: null,
        resource_kinds: ['table'],
        weekdays: [2, 3, 4, 5, 6],
        last_start: '14:00',
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: 4,
          late_fee_per_person: 10000,
          no_show_fee_per_person: 10000,
        },
        deposit: null,
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
      2: [LUNCH, { open: '17:00', close: '22:00' }],
      3: [LUNCH, { open: '17:00', close: '22:00' }],
      4: [LUNCH, { open: '17:00', close: '22:00' }],
      5: [LUNCH, { open: '17:00', close: '23:00' }],
      6: [LUNCH, { open: '17:00', close: '23:00' }],
    },
    // Two 4-tops pushed together seat 5 to 8. A single table is always tried first.
    table_combinations: [{ resource_ids: ['t6', 't7'], min_party_size: 5, max_party_size: 8 }],
    service_periods: [
      {
        name: 'Lunch',
        weekdays: [2, 3, 4, 5, 6],
        open: '11:30',
        close: '14:00',
        seatings: ['12:00', '13:15'],
      },
      { name: 'Dinner', weekdays: [2, 3, 4, 5, 6], open: '17:00', close: '22:00' },
      // A quiet day: the rest of the room is kept for walk-ins.
      {
        name: 'Sunday supper',
        weekdays: [0],
        open: '16:00',
        close: '21:00',
        max_online_guests: 24,
      },
    ],
    pacing: { max_guests_per_interval: 20, interval_minutes: 15 },
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
