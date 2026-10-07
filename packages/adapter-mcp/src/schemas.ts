/**
 * Agent-facing MCP tool schemas. Deliberately flatter than the core model (e.g. `party_size` is a
 * plain integer) because small, obvious inputs measurably reduce agent errors.
 */
import {
  CancellationPolicySchema,
  CustomerSchema,
  DateSchema,
  DepositTermsSchema,
  ErrorPayloadSchema,
  IdempotencyKeySchema,
  LocalTimeSchema,
  MoneySchema,
  BookingStatusSchema,
} from '@openbooking-sh/core';
import * as z from 'zod';

const customer = CustomerSchema.describe(
  'The person the booking is for. first_name, last_name and at least one of email or phone_number.',
);

export const GetBusinessInfoInput = z.object({
  venue_id: z.string().optional().describe('Omit when the server serves a single venue'),
});

export const SearchAvailabilityInput = z.object({
  date: DateSchema,
  party_size: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(1)
    .describe('Number of people. 1 for a normal appointment; the number of guests for a table'),
  time_from: LocalTimeSchema.optional().describe(
    'Earliest acceptable start time HH:MM (venue local time)',
  ),
  time_to: LocalTimeSchema.optional().describe(
    'Latest acceptable start time HH:MM (venue local time)',
  ),
  venue_id: z.string().optional().describe('Omit when the server serves a single venue'),
  offering_id: z
    .string()
    .optional()
    .describe('Service id from get_business_info, e.g. "haircut". Omit to see all services'),
  staff: z
    .string()
    .optional()
    .describe('A specific staff member by name, e.g. "Kari" (any capitalisation). Omit for anyone'),
  preferences: z
    .array(z.string())
    .optional()
    .describe('Other required features, e.g. ["outdoor"] for a table. Omit if the user has none'),
  limit: z.number().int().min(1).max(50).optional().describe('Max slots to return (default 20)'),
});

export const HoldSlotInput = z.object({
  slot_id: z.string().min(1).describe('slot_id exactly as returned by search_availability'),
  idempotency_key: IdempotencyKeySchema,
  customer: customer.optional(),
  notes: z
    .string()
    .max(500)
    .optional()
    .describe('Notes for the business, e.g. "short on the sides", allergies or a high chair'),
});

export const ConfirmBookingInput = z.object({
  booking_id: z.string().min(1).describe('booking_id returned by hold_slot'),
  user_confirmed: z
    .boolean()
    .describe(
      'Set true ONLY after the user explicitly approved this exact booking (time, party size, price, deposit, cancellation policy) in this conversation.',
    ),
  idempotency_key: IdempotencyKeySchema,
  customer: customer.optional().describe('Required here if it was not given to hold_slot'),
  payment_token: z
    .string()
    .optional()
    .describe(
      'Payment token for the deposit, only when the hold shows deposit.due = "at_confirmation"',
    ),
});

export const GetBookingInput = z.object({
  booking_id: z.string().min(1),
});

export const CancelBookingInput = z.object({
  booking_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
  user_confirmed: z
    .boolean()
    .optional()
    .describe(
      'Required (true) to cancel a CONFIRMED booking, after the user approved the cancellation terms. Not needed to release a hold.',
    ),
  reason: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const SlotView = z.object({
  slot_id: z.string(),
  start: z.string(),
  end: z.string(),
  local_time: z.string().describe('Start time HH:MM in the venue time zone'),
  offering: z.object({ id: z.string(), name: z.string() }),
  resource: z
    .string()
    .optional()
    .describe(
      'Who or what is booked: a staff member such as "Maria", or "Table for up to 4, outdoor"',
    ),
  also_available: z
    .array(z.string())
    .optional()
    .describe('Other staff free at this time. To book one of them, search again with staff'),
  price: MoneySchema.nullable(),
  deposit: DepositTermsSchema.nullable(),
  cancellation_policy: CancellationPolicySchema,
});

export const SearchAvailabilityOutput = z.object({
  venue: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  date: z.string(),
  party_size: z.number(),
  slots: z.array(SlotView),
  next_step: z.string(),
});

export const BookingView = z.object({
  booking_id: z.string(),
  status: BookingStatusSchema,
  venue: z.object({ id: z.string(), name: z.string() }),
  start: z.string(),
  end: z.string(),
  local_date: z.string(),
  local_time: z.string(),
  party_size: z.number(),
  offering: z.object({ id: z.string(), name: z.string() }),
  resource: z.string().nullable().describe('Who or what is booked, e.g. the staff member'),
  customer: CustomerSchema.nullable(),
  notes: z.string().nullable(),
  price: MoneySchema.nullable(),
  deposit: DepositTermsSchema.nullable(),
  cancellation_policy: CancellationPolicySchema,
  /** Only while held. Always explicit so agents never have to guess the deadline. */
  expires_at: z.string().nullable(),
  expires_in_seconds: z.number().nullable(),
  confirmation_code: z.string().nullable(),
  payment_status: z.string(),
  cancellation: z
    .object({
      reason: z.string().nullable(),
      fee: MoneySchema.nullable(),
      refund: MoneySchema.nullable(),
    })
    .nullable(),
  next_step: z.string(),
});

export const BusinessInfoOutput = z.object({
  venue: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    address: z.string().nullable(),
    phone_number: z.string().nullable(),
    timezone: z.string(),
    currency: z.string().nullable(),
  }),
  services: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      duration_minutes: z.number(),
      price: MoneySchema.nullable(),
    }),
  ),
  staff: z.array(z.string()).describe('Staff members customers can ask for by name'),
  staff_hours: z
    .record(z.string(), z.record(z.string(), z.string()))
    .describe(
      'Working hours of staff who have their own, by name and weekday, e.g. { Maria: { fri: "12:00-18:00", sat: "off" } }. Staff not listed work whenever the business is open.',
    ),
  opening_hours: z
    .record(z.string(), z.string())
    .nullable()
    .describe('Per weekday, e.g. { mon: "closed", tue: "10:00-19:00" }'),
  closed_dates: z.array(z.string()),
  booking_window: z
    .object({ min_lead_minutes: z.number().nullable(), max_days_ahead: z.number().nullable() })
    .nullable(),
  next_step: z.string(),
});

export const ToolErrorOutput = z.object({ error: ErrorPayloadSchema });
