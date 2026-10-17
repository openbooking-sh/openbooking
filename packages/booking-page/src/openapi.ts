/**
 * OpenAPI 3.1 document for the booking page API, generated from the schemas in `api.ts` so it
 * always describes what the page really sends and accepts. Served at `<page>/book/api/openapi.json`.
 */
import {
  AvailabilityParamsSchema,
  AvailabilityResponseSchema,
  BookingDetailSchema,
  BookingResponseSchema,
  BookingViewSchema,
  CancelRequestSchema,
  ConfirmRequestSchema,
  ConfirmResponseSchema,
  ConfirmedHoldViewSchema,
  ErrorResponseSchema,
  HoldDetailResponseSchema,
  HoldRequestSchema,
  HoldResponseSchema,
  InfoResponseSchema,
  ReleaseResponseSchema,
  SlotViewSchema,
} from './api';
import {
  AddressSchema,
  CancellationPolicySchema,
  CustomerSchema,
  DepositTermsSchema,
  ErrorPayloadSchema,
  MoneySchema,
} from '@openbooking-sh/core';
import * as z from 'zod';

export interface OpenApiOptions {
  /** Absolute URL of the API, e.g. `https://app.openbooking.sh/b/studio-nord/book/api`. */
  apiUrl: string;
  /** Business name, for the title. */
  name?: string;
}

/** Schemas that are referenced from several places get a name and one definition. */
const components = z.registry<{ id: string }>();
const named: Array<[z.ZodType, string]> = [
  [MoneySchema, 'Money'],
  [AddressSchema, 'Address'],
  [CancellationPolicySchema, 'CancellationPolicy'],
  [DepositTermsSchema, 'DepositTerms'],
  [CustomerSchema, 'Customer'],
  [ErrorPayloadSchema, 'Error'],
  [SlotViewSchema, 'Slot'],
  [BookingViewSchema, 'Booking'],
  [BookingDetailSchema, 'BookingDetail'],
  [ConfirmedHoldViewSchema, 'ConfirmedHold'],
  [InfoResponseSchema, 'InfoResponse'],
  [AvailabilityResponseSchema, 'AvailabilityResponse'],
  [HoldResponseSchema, 'HoldResponse'],
  [ConfirmResponseSchema, 'ConfirmResponse'],
  [ReleaseResponseSchema, 'ReleaseResponse'],
  [HoldDetailResponseSchema, 'HoldDetailResponse'],
  [BookingResponseSchema, 'BookingResponse'],
  [ErrorResponseSchema, 'ErrorResponse'],
  [HoldRequestSchema, 'HoldRequest'],
  [ConfirmRequestSchema, 'ConfirmRequest'],
  [CancelRequestSchema, 'CancelRequest'],
];
for (const [schema, id] of named) components.add(schema, { id });

type Json = Record<string, unknown>;

/** JSON Schema from zod, tidied for OpenAPI (no per-schema `$schema`/`$id`, no date-time regexes). */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (node && typeof node === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === '$schema' || k === '$id') continue;
      out[k] = tidy(v);
    }
    // The regex only repeats `format: date-time` and makes the document unreadable.
    if (out.format === 'date-time' || out.format === 'date') delete out.pattern;
    if (out.type === 'integer' && out.maximum === Number.MAX_SAFE_INTEGER) delete out.maximum;
    return out;
  }
  return node;
}

function schemas(): Record<string, unknown> {
  const generated = z.toJSONSchema(components, {
    target: 'draft-2020-12',
    uri: (id) => `#/components/schemas/${id}`,
    unrepresentable: 'any',
  }).schemas;
  return tidy(generated) as Record<string, unknown>;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (name: string) => ({ 'application/json': { schema: ref(name) } });

const errors = {
  '400': { description: 'The request is invalid (`validation_error`).' },
  '404': { description: 'Nothing found for that id or code (`not_found`).' },
  '409': {
    description:
      'The time was just taken (`slot_unavailable`) or the idempotency key was used for a different action (`idempotency_conflict`).',
  },
  '422': {
    description:
      'The request is valid but the booking rules refuse it, for example `hold_expired`, `user_confirmation_required`, `customer_details_required`, `cancellation_not_allowed`, `invalid_state`. Read `error.suggested_next_action`.',
  },
  '429': { description: 'Too many requests (hosted OpenBooking). Wait and retry.' },
  '503': {
    description: 'The booking system is temporarily unavailable (`provider_error`). Retry.',
  },
};

const failures = Object.fromEntries(
  Object.entries(errors).map(([status, r]) => [
    status,
    { ...r, content: jsonBody('ErrorResponse') },
  ]),
);

const idParam = (what: string) => ({
  name: 'id',
  in: 'path',
  required: true,
  description: what,
  schema: { type: 'string' },
});

const idempotency =
  'Send a unique `idempotency_key` with every write (a UUID is ideal). Repeating a call with the **same** key never books twice, so retry freely after a network error. Never reuse a key for a different action.';

export function buildOpenApi(options: OpenApiOptions): Json {
  const availability = z.toJSONSchema(AvailabilityParamsSchema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as { properties: Record<string, Json>; required?: string[] };

  return {
    openapi: '3.1.0',
    info: {
      title: options.name ? `${options.name}: booking API` : 'OpenBooking booking page API',
      version: '1',
      description: [
        'Check availability and book appointments. Every booking is a **hold** first (the time is reserved for a few minutes), then a **confirmation**. A booking is only confirmed with `user_confirmed: true`, after the customer has seen the time, price and cancellation terms.',
        idempotency,
        'Prices are integers in minor units (`65000` = 650.00). Times are ISO 8601 with the venue offset.',
        'Every error has the shape `{ "error": { code, message, suggested_next_action, retryable } }`.',
      ].join('\n\n'),
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{ url: options.apiUrl }],
    tags: [
      { name: 'Browse', description: 'Read what the business offers and when it is free.' },
      { name: 'Book', description: 'Hold, confirm and release.' },
      { name: 'Manage', description: 'View or cancel a booking with its confirmation code.' },
    ],
    paths: {
      '/info': {
        get: {
          operationId: 'getInfo',
          tags: ['Browse'],
          summary: 'The business, its services and staff',
          responses: {
            '200': { description: 'The business.', content: jsonBody('InfoResponse') },
            ...failures,
          },
        },
      },
      '/availability': {
        get: {
          operationId: 'getAvailability',
          tags: ['Browse'],
          summary: 'Free times on one day',
          parameters: Object.entries(availability.properties).map(([name, schema]) => ({
            name,
            in: 'query',
            required: availability.required?.includes(name) ?? false,
            ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
            schema: tidy({ ...schema, description: undefined }),
          })),
          responses: {
            '200': { description: 'Free times.', content: jsonBody('AvailabilityResponse') },
            ...failures,
          },
        },
      },
      '/hold': {
        post: {
          operationId: 'hold',
          tags: ['Book'],
          summary: 'Reserve a time for a few minutes',
          description: `Nothing is booked yet. Show the person the time, price and cancellation terms, then call \`confirm\` before \`expires_at\`. ${idempotency}`,
          requestBody: { required: true, content: jsonBody('HoldRequest') },
          responses: {
            '200': { description: 'The hold.', content: jsonBody('HoldResponse') },
            ...failures,
          },
        },
      },
      '/holds/{id}': {
        get: {
          operationId: 'getHold',
          tags: ['Book'],
          summary: 'Read a hold (what the confirm page shows)',
          description:
            'A booking that is already confirmed shows only that it is, never its code or the customer name.',
          parameters: [idParam('The `booking_id` of the hold.')],
          responses: {
            '200': { description: 'The hold.', content: jsonBody('HoldDetailResponse') },
            ...failures,
          },
        },
      },
      '/holds/{id}/release': {
        post: {
          operationId: 'releaseHold',
          tags: ['Book'],
          summary: 'Let go of a hold that is no longer wanted',
          parameters: [idParam('The `booking_id` of the hold.')],
          responses: {
            '200': {
              description:
                '`released` is false when it was not a hold (already confirmed or gone).',
              content: jsonBody('ReleaseResponse'),
            },
            ...failures,
          },
        },
      },
      '/confirm': {
        post: {
          operationId: 'confirm',
          tags: ['Book'],
          summary: 'Confirm a held booking',
          description: `Only after the customer approved the time, price and cancellation terms. ${idempotency}`,
          requestBody: { required: true, content: jsonBody('ConfirmRequest') },
          responses: {
            '200': { description: 'The confirmed booking.', content: jsonBody('ConfirmResponse') },
            ...failures,
          },
        },
      },
      '/bookings/{id}': {
        get: {
          operationId: 'getBooking',
          tags: ['Manage'],
          summary: 'Read a booking',
          parameters: [
            idParam('The `booking_id`.'),
            {
              name: 'code',
              in: 'query',
              required: true,
              description: 'The confirmation code.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'The booking.', content: jsonBody('BookingResponse') },
            ...failures,
          },
        },
      },
      '/bookings/{id}/cancel': {
        post: {
          operationId: 'cancel',
          tags: ['Manage'],
          summary: 'Cancel a booking',
          description: `Cancelling a confirmed booking needs the customer's approval of the cancellation terms: send \`user_confirmed: true\` once they said yes. Without it the call answers 422 \`user_confirmation_required\`, with the fee (if any) in \`error.details\`, and cancels nothing. ${idempotency}`,
          parameters: [idParam('The `booking_id`.')],
          requestBody: { required: true, content: jsonBody('CancelRequest') },
          responses: {
            '200': { description: 'The cancelled booking.', content: jsonBody('BookingResponse') },
            ...failures,
          },
        },
      },
    },
    components: { schemas: schemas() },
  };
}
