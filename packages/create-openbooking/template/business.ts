import type { MemoryProviderConfig } from '@openbooking-sh/provider-memory';

/**
 * Your business: who can be booked, what can be booked, when, and the rules. Edit freely.
 *
 * - Prices are in minor units: 65000 = 650.00.
 * - Opening hours use weekday numbers: 0 = Sunday … 6 = Saturday. Missing = closed.
 * - Tags let customers (and AI assistants) ask for someone by name.
 */
const VENUE = '{{PROJECT_NAME}}';
const CURRENCY = 'NOK';
const free24h = (price: number) => ({
  refundability: 'refundable' as const,
  free_until_hours_before: 24,
  late_fee_per_person: Math.round(price / 2),
  no_show_fee_per_person: Math.round(price / 2),
});

export const business: MemoryProviderConfig = {
  name: '{{BUSINESS_NAME}}',
  venues: [
    {
      venue: {
        id: VENUE,
        name: '{{BUSINESS_NAME}}',
        timezone: 'Europe/Oslo',
        currency: CURRENCY,
        address: {
          street_address: 'Street 1',
          postal_code: '0000',
          address_locality: 'Oslo',
          address_country: 'NO',
        },
        phone_number: '+47 00 00 00 00',
        description: 'Book online or ask your AI assistant.',
      },
      currency: CURRENCY,
      resources: [
        {
          id: 'maria',
          venue_id: VENUE,
          kind: 'staff',
          name: 'Maria',
          capacity: { min: 1, max: 1 },
          tags: ['maria'],
        },
        {
          id: 'jonas',
          venue_id: VENUE,
          kind: 'staff',
          name: 'Jonas',
          capacity: { min: 1, max: 1 },
          tags: ['jonas'],
        },
      ],
      offerings: [
        {
          id: 'haircut',
          venue_id: VENUE,
          name: 'Haircut',
          duration_minutes: 45,
          price_per_person: { amount: 65000, currency: CURRENCY },
          resource_kinds: ['staff'],
          cancellation: free24h(65000),
          deposit: null,
        },
        {
          id: 'beard-trim',
          venue_id: VENUE,
          name: 'Beard trim',
          duration_minutes: 30,
          price_per_person: { amount: 35000, currency: CURRENCY },
          resource_kinds: ['staff'],
          cancellation: free24h(35000),
          deposit: null,
        },
      ],
      opening_hours: {
        1: [{ open: '09:00', close: '17:00' }],
        2: [{ open: '09:00', close: '17:00' }],
        3: [{ open: '09:00', close: '17:00' }],
        4: [{ open: '09:00', close: '17:00' }],
        5: [{ open: '09:00', close: '17:00' }],
        6: [{ open: '10:00', close: '15:00' }],
      },
      slot_interval_minutes: 15,
      buffer_minutes: 10,
      min_lead_minutes: 60,
      max_days_ahead: 60,
    },
  ],
};
