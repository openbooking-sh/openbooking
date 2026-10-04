import { OB, UCP, UCP_SITE } from './constants';

const money = {
  type: 'object',
  required: ['amount', 'currency'],
  properties: {
    amount: { type: 'integer', minimum: 0, description: 'Minor units' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  },
};

/** EXTENSION: `stays[].time_slot`, sub-day booking window (UCP `stay_dates` are dates only). */
const timeSlot = {
  type: 'object',
  required: ['start_at', 'end_at', 'timezone'],
  properties: {
    start_at: { type: 'string', format: 'date-time' },
    end_at: { type: 'string', format: 'date-time' },
    timezone: { type: 'string', description: 'IANA time zone of the venue' },
  },
};

/**
 * JSON Schema for `sh.openbooking.booking`, following the UCP extension pattern:
 * a `$defs` entry keyed by the parent capability that `allOf`s the parent schema.
 */
export function bookingExtensionSchema(id: string) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    name: OB.booking,
    title: 'OpenBooking booking extension',
    description:
      'Adds sub-day time slots, an explicit user-consent flag, a payment token and agent guidance to dev.ucp.lodging.booking.',
    $defs: {
      [UCP.booking]: {
        allOf: [
          { $ref: `${UCP_SITE}/schemas/lodging/booking.json` },
          {
            type: 'object',
            properties: {
              stays: {
                type: 'array',
                items: { type: 'object', properties: { time_slot: timeSlot } },
              },
              user_confirmed: {
                type: 'boolean',
                description:
                  'Request-only (complete, cancel). Must be true: the platform asserts the user explicitly approved this exact booking or cancellation.',
              },
              payment_token: {
                type: 'string',
                description: 'Request-only (complete). Token for a deposit due at confirmation.',
              },
              messages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    suggested_next_action: {
                      type: 'string',
                      description: 'What the agent should do next to recover from this message.',
                    },
                  },
                },
              },
              policies: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    free_cancellation_until: { type: ['string', 'null'], format: 'date-time' },
                    late_cancellation_fee: { oneOf: [money, { type: 'null' }] },
                    no_show_fee: { oneOf: [money, { type: 'null' }] },
                  },
                },
              },
            },
          },
        ],
      },
    },
  };
}

/** JSON Schema for the `sh.openbooking.availability` response. */
export function availabilitySchema(id: string) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    name: OB.availability,
    title: 'OpenBooking availability search',
    description:
      'GET {endpoint}/availability?date=YYYY-MM-DD&party_size=N[&time_from=HH:MM][&time_to=HH:MM][&offering_id=][&tags=a,b][&venue_id=][&limit=]. Each result is a stay offer; pass its id as stays[0].id to POST /booking-sessions.',
    type: 'object',
    required: ['ucp', 'property', 'offers'],
    properties: {
      ucp: { type: 'object' },
      property: { type: 'object', required: ['id', 'name'] },
      offers: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'id',
            'stay_dates',
            'time_slot',
            'accommodation_type',
            'rate_plan',
            'occupancy',
            'totals',
            'policies',
          ],
          properties: {
            id: { type: 'string', description: 'Opaque stay/slot id' },
            stay_dates: { type: 'object' },
            time_slot: timeSlot,
            accommodation_type: { type: 'object' },
            rate_plan: { type: 'object' },
            occupancy: { type: 'object' },
            totals: { type: 'array' },
            policies: { type: 'array' },
            payment_terms: { type: 'array' },
          },
        },
      },
    },
  };
}
