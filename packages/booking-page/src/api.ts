/**
 * The JSON API of the booking page (`<page>/book/api/*`), described once as zod schemas. The
 * OpenAPI document is generated from these, the contract test parses every real response with
 * them, and the types in `@openbooking-sh/client` are checked against them, so the three cannot
 * drift apart.
 */
import {
  AddressSchema,
  BookingStatusSchema,
  CancellationPolicySchema,
  CustomerSchema,
  DateSchema,
  DateTimeSchema,
  DepositTermsSchema,
  ErrorPayloadSchema,
  IdempotencyKeySchema,
  LocalTimeSchema,
  MoneySchema,
} from '@openbooking-sh/core';
import * as z from 'zod';

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const Staff = z.object({ id: z.string(), name: z.string() });

export const InfoResponseSchema = z.object({
  venue: z.object({
    name: z.string(),
    description: z.string().nullable(),
    address: AddressSchema.nullable(),
    phone_number: z.string().nullable(),
    timezone: z.string().describe('IANA time zone, e.g. Europe/Oslo'),
    currency: z.string().nullable(),
  }),
  services: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      duration_minutes: z.number().int(),
      price: MoneySchema.nullable().describe('Per person. null = priced at the venue.'),
    }),
  ),
  staff: z.array(Staff),
  profile: z.object({
    category: z.string().optional(),
    email: z.string().optional(),
    website: z.string().optional(),
  }),
  booking_page: z.string().describe('The public booking page, for people.'),
});

export const SlotViewSchema = z.object({
  slot_id: z.string().describe('Opaque. Pass it to `hold` to reserve this time.'),
  start: DateTimeSchema,
  end: DateTimeSchema,
  offering: z.object({ id: z.string(), name: z.string() }),
  resource: z.object({ id: z.string().nullable(), label: z.string() }).nullable(),
  price: MoneySchema.nullable(),
  deposit: DepositTermsSchema.nullable(),
  cancellation_policy: CancellationPolicySchema,
});

export const AvailabilityResponseSchema = z.object({
  date: DateSchema,
  slots: z.array(SlotViewSchema),
});

const bookingFields = {
  booking_id: z.string(),
  status: BookingStatusSchema,
  start: DateTimeSchema,
  end: DateTimeSchema,
  offering: z.object({ id: z.string(), name: z.string() }),
  resource: z.string().nullable().describe('Staff member or table, by name.'),
  party_size: z.number().int(),
  price: MoneySchema.nullable(),
  deposit: DepositTermsSchema.nullable(),
  cancellation_policy: CancellationPolicySchema,
};

/** A booking as the page returns it right after a hold, a confirmation or a cancellation. */
export const BookingViewSchema = z.object({
  ...bookingFields,
  expires_at: DateTimeSchema.nullable().describe('Set while held: the hold is released then.'),
  confirmation_code: z.string().nullable().describe('Set once confirmed.'),
});

/** A booking read with its confirmation code or by someone holding the hold: adds the customer. */
export const BookingDetailSchema = BookingViewSchema.extend({
  customer: z.object({ first_name: z.string(), last_name: z.string() }).nullable(),
  cancellation: z
    .object({
      reason: z.string().nullable(),
      fee: MoneySchema.nullable(),
      refund: MoneySchema.nullable(),
    })
    .nullable(),
});

/** What a confirmed booking shows to someone who only has its id: no code, no name. */
export const ConfirmedHoldViewSchema = z.object(bookingFields);

export const HoldResponseSchema = z.object({ booking: BookingViewSchema });
export const ConfirmResponseSchema = z.object({
  booking: BookingViewSchema.extend({
    manage_url: z
      .string()
      .nullable()
      .describe('Where the customer can view or cancel the booking. Keep the link private.'),
  }),
});
export const ReleaseResponseSchema = z.object({ released: z.boolean() });
export const HoldDetailResponseSchema = z.object({
  booking: z.union([BookingDetailSchema, ConfirmedHoldViewSchema]),
});
export const BookingResponseSchema = z.object({ booking: BookingDetailSchema });
export const ErrorResponseSchema = z.object({ error: ErrorPayloadSchema });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const HoldRequestSchema = z.object({
  slot_id: z.string(),
  idempotency_key: IdempotencyKeySchema,
});

export const ConfirmRequestSchema = z.object({
  booking_id: z.string(),
  idempotency_key: IdempotencyKeySchema,
  user_confirmed: z
    .literal(true)
    .describe(
      'Must be true, and only after the customer saw the time, price and cancellation terms and said yes.',
    ),
  customer: CustomerSchema,
  notes: z.string().optional(),
  payment_token: z
    .string()
    .optional()
    .describe(
      'The Stripe session id the customer came back with, for bookings with an online deposit.',
    ),
});

export const CancelRequestSchema = z.object({
  code: z.string().describe('The confirmation code of the booking.'),
  idempotency_key: IdempotencyKeySchema,
  user_confirmed: z
    .boolean()
    .optional()
    .describe(
      'Required (true) to cancel a confirmed booking, after the customer saw the cancellation terms. Without it the call answers 422 `user_confirmation_required` and cancels nothing.',
    ),
});

export const AvailabilityParamsSchema = z.object({
  date: DateSchema,
  service: z.string().optional().describe('A service id from `info`.'),
  staff: z.string().optional().describe('A staff id from `info`.'),
  party: z.number().int().min(1).optional().describe('Number of guests. Default 1.'),
  time_from: LocalTimeSchema.optional(),
  time_to: LocalTimeSchema.optional(),
});
