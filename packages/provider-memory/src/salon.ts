import type { Resource } from '@openbooking/core';
import type { MemoryProviderConfig, VenueConfig } from './config';

const VENUE_ID = 'studio-nord';

const stylist = (id: string, name: string, tags: string[]): Resource => ({
  id,
  venue_id: VENUE_ID,
  kind: 'staff',
  name,
  capacity: { min: 1, max: 1 },
  // Lower-case name as a tag so agents can ask for a specific person: preferences ["maria"].
  tags: [name.toLowerCase(), ...tags],
});

/**
 * A fictional hair salon used by the demo.
 *
 * - Open Tue–Fri 09–18, Sat 10–16. Europe/Oslo, NOK.
 * - Three stylists (Maria, Jonas, Aisha); each service books one stylist.
 * - Haircut 45 min / 650 NOK, Beard trim 30 min / 350 NOK, Color & cut 120 min / 1 450 NOK
 *   with a 300 NOK deposit at confirmation.
 * - Free cancellation until 24h before; later cancellations and no-shows cost 50% (haircut,
 *   beard) or keep the deposit (color).
 */
export function demoSalonVenue(): VenueConfig {
  return {
    venue: {
      id: VENUE_ID,
      name: 'Studio Nord',
      timezone: 'Europe/Oslo',
      currency: 'NOK',
      address: {
        street_address: 'Eksempelgata 12',
        address_locality: 'Oslo',
        postal_code: '0550',
        address_country: 'NO',
      },
      phone_number: '+4700000001',
      description: 'Fictional neighbourhood hair salon used for OpenBooking demos.',
    },
    currency: 'NOK',
    resources: [
      stylist('maria', 'Maria', ['color', 'senior']),
      stylist('jonas', 'Jonas', ['barber']),
      stylist('aisha', 'Aisha', ['color']),
    ],
    offerings: [
      {
        id: 'haircut',
        venue_id: VENUE_ID,
        name: 'Haircut',
        description: 'Wash, cut and style. 45 minutes.',
        duration_minutes: 45,
        price_per_person: { amount: 65000, currency: 'NOK' },
        resource_kinds: ['staff'],
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: 24,
          late_fee_per_person: 32500,
          no_show_fee_per_person: 32500,
        },
        deposit: null,
      },
      {
        id: 'beard-trim',
        venue_id: VENUE_ID,
        name: 'Beard trim',
        description: 'Beard shape and trim. 30 minutes.',
        duration_minutes: 30,
        price_per_person: { amount: 35000, currency: 'NOK' },
        resource_kinds: ['staff'],
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: 24,
          late_fee_per_person: 17500,
          no_show_fee_per_person: 17500,
        },
        deposit: null,
      },
      {
        id: 'color-cut',
        venue_id: VENUE_ID,
        name: 'Color & cut',
        description: 'Full color, cut and style. About 2 hours.',
        duration_minutes: 120,
        price_per_person: { amount: 145000, currency: 'NOK' },
        resource_kinds: ['staff'],
        cancellation: {
          refundability: 'partially_refundable',
          free_until_hours_before: 24,
          late_fee_per_person: 30000,
          no_show_fee_per_person: 72500,
        },
        deposit: { min_party_size: 1, amount_per_person: 30000, due: 'at_confirmation' },
      },
    ],
    opening_hours: {
      2: [{ open: '09:00', close: '18:00' }],
      3: [{ open: '09:00', close: '18:00' }],
      4: [{ open: '09:00', close: '18:00' }],
      5: [{ open: '09:00', close: '18:00' }],
      6: [{ open: '10:00', close: '16:00' }],
    },
    closed_dates: ['2026-12-24', '2026-12-25', '2026-12-26', '2026-12-31'],
    slot_interval_minutes: 15,
    buffer_minutes: 10,
    min_lead_minutes: 60,
    max_days_ahead: 60,
  };
}

export function demoSalonConfig(): MemoryProviderConfig {
  return {
    name: 'Studio Nord',
    description: 'In-memory demo hair salon for OpenBooking.',
    venues: [demoSalonVenue()],
  };
}
