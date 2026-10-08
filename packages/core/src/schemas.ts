/**
 * OpenBooking domain model.
 *
 * Field names follow UCP lodging (`dev.ucp.lodging.booking`, draft on UCP main@b0e81ade) wherever an
 * equivalent exists: snake_case, ISO 8601 timestamps, integer minor-unit amounts, `first_name` /
 * `last_name` / `email` / `phone_number` for the booker, `occupancy`-style party size.
 * Anything without a UCP equivalent is marked `EXTENSION:` and listed in docs/SPEC-NOTES.md.
 */
import * as z from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO 8601 date-time with an explicit UTC offset, e.g. `2026-10-03T19:00:00+02:00`. */
export const DateTimeSchema = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 date-time with UTC offset, e.g. 2026-10-03T19:00:00+02:00');

/** Calendar date `YYYY-MM-DD`, interpreted in the venue's local time zone. */
export const DateSchema = z.iso.date().describe('Calendar date YYYY-MM-DD in the venue local time');

/** Local wall-clock time `HH:MM` (24h). */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)')
  .describe('Local time HH:MM (24h) in the venue time zone');

/** ISO 4217 currency code. Matches UCP `currency`. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'Expected ISO 4217 code, e.g. NOK');

/** Amount in integer minor units (e.g. øre/cents), as in UCP `totals[].amount`. */
export const MoneySchema = z.object({
  amount: z.number().int().nonnegative().describe('Integer amount in minor units (e.g. cents)'),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

/**
 * Idempotency key for mutating calls. UCP REST uses an `Idempotency-Key` (uuid) header; agents
 * should pass a UUID. The same key MUST be reused when retrying the same intended action.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .describe(
    'Unique key for this intended action (a UUID is ideal). Reuse the SAME key when retrying the same call; never reuse it for a different action.',
  );

// ---------------------------------------------------------------------------
// Venue, resources, offerings
// ---------------------------------------------------------------------------

/** Postal address, mirroring UCP's postal address field names. */
export const AddressSchema = z.object({
  street_address: z.string().optional(),
  address_locality: z.string().optional(),
  address_region: z.string().optional(),
  postal_code: z.string().optional(),
  address_country: z.string().optional(),
});
export type Address = z.infer<typeof AddressSchema>;

/** A bookable location. Maps to UCP `property` (`location_summary`: `id`, `name`, `address`). */
export const VenueSchema = z.object({
  id: z.string(),
  name: z.string(),
  // EXTENSION: UCP property has no time zone; we need it to interpret local slot times.
  timezone: z.string().describe('IANA time zone, e.g. Europe/Oslo'),
  /** Default currency for prices, deposits and fees (UCP `currency`). */
  currency: CurrencySchema.optional(),
  address: AddressSchema.optional(),
  phone_number: z.string().optional(),
  url: z.url().optional(),
  description: z.string().optional(),
});
export type Venue = z.infer<typeof VenueSchema>;

/**
 * Something that gets occupied by a booking: a table, a staff member, a room, a chair.
 * Maps loosely to UCP `accommodation_type` (`id`, `title`, `capacity`).
 */
export const ResourceSchema = z.object({
  id: z.string(),
  venue_id: z.string(),
  kind: z.string().describe('e.g. table, staff, room'),
  name: z.string(),
  capacity: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
  tags: z.array(z.string()).default([]),
});
export type Resource = z.infer<typeof ResourceSchema>;

/**
 * What is being booked: "Dinner", "Tasting menu", "Haircut 45 min".
 * Maps to UCP `rate_plan` (`id`, `title`, `description`).
 */
export const OfferingSchema = z.object({
  id: z.string(),
  venue_id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  duration_minutes: z.number().int().positive(),
  price_per_person: MoneySchema.nullable().default(null),
});
export type Offering = z.infer<typeof OfferingSchema>;

// ---------------------------------------------------------------------------
// Party size, customer
// ---------------------------------------------------------------------------

/** Mirrors UCP `occupancy` (`adults`, `children`, `child_ages`, `total` required). */
export const PartySizeSchema = z
  .object({
    total: z.number().int().min(1).max(100).describe('Total number of guests'),
    adults: z.number().int().min(0).optional(),
    children: z.number().int().min(0).optional(),
    child_ages: z.array(z.number().int().min(0).max(17)).optional(),
  })
  .refine(
    (p) => p.adults === undefined || p.children === undefined || p.adults + p.children === p.total,
    { message: 'adults + children must equal total' },
  );
export type PartySize = z.infer<typeof PartySizeSchema>;

/**
 * The person the booking is for and who is contacted about it. Mirrors UCP lodging `booker`
 * (`first_name`, `last_name`, `email`, `phone_number`). UCP requires a lead with a name plus email
 * or phone before `ready_for_complete`; we enforce the same rule.
 */
export const CustomerSchema = z
  .object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    email: z.email().optional(),
    phone_number: z
      .string()
      .regex(/^\+?[0-9 ()-]{6,20}$/, 'Expected a phone number, ideally E.164 like +4712345678')
      .optional(),
  })
  .refine((c) => c.email !== undefined || c.phone_number !== undefined, {
    message: 'Provide at least one of email or phone_number',
    path: ['email'],
  });
export type Customer = z.infer<typeof CustomerSchema>;

// ---------------------------------------------------------------------------
// Policies and terms
// ---------------------------------------------------------------------------

/**
 * Cancellation terms for one specific slot/booking (absolute timestamps, already computed by the
 * provider). Maps to UCP `dev.ucp.lodging.policy.cancellation` (`refundability`, `description`).
 */
export const CancellationPolicySchema = z.object({
  /** UCP `refundability` (open string in UCP; we restrict to the three documented examples). */
  refundability: z.enum(['refundable', 'partially_refundable', 'non_refundable']),
  /** Human-readable summary; maps to UCP `description.plain`. Show this to the user verbatim. */
  description: z.string(),
  // EXTENSION: UCP only has free-text deadlines (structured schedules are proposed in UCP PR #861).
  free_cancellation_until: DateTimeSchema.nullable().describe(
    'Cancel before this instant for free. null = never free.',
  ),
  // EXTENSION: structured fees.
  late_cancellation_fee: MoneySchema.nullable(),
  no_show_fee: MoneySchema.nullable(),
});
export type CancellationPolicy = z.infer<typeof CancellationPolicySchema>;

/**
 * Deposit/guarantee requirement. Maps to UCP `dev.ucp.common.payment.terms`
 * (`payment.terms[].schedules[]` with `type` `immediate` | `at_property`).
 */
export const DepositTermsSchema = z.object({
  amount: MoneySchema,
  /** `at_confirmation` ↔ UCP schedule type `immediate`; `at_venue` ↔ `at_property`. */
  due: z.enum(['at_confirmation', 'at_venue']),
  description: z.string(),
});
export type DepositTerms = z.infer<typeof DepositTermsSchema>;

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * A bookable time slot returned by search. `slot_id` is opaque and provider-defined; it encodes
 * everything needed to hold the slot (venue, offering, start time, party size).
 *
 * EXTENSION: UCP has no availability/search capability (lodging roadmap lists it as future work);
 * a slot maps onto a UCP `stay` whose `id` is the `slot_id`.
 */
export const SlotSchema = z.object({
  slot_id: z.string(),
  venue_id: z.string(),
  offering: z.object({ id: z.string(), name: z.string() }),
  start: DateTimeSchema,
  end: DateTimeSchema,
  party_size: PartySizeSchema,
  resource: z
    .object({
      /** Provider resource id (e.g. staff member or table), used by calendars to group bookings. */
      id: z.string().optional(),
      kind: z.string(),
      label: z.string(),
      tags: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * Other resources (e.g. staff members) also free at this time, by label. The slot books
   * `resource`; to book one of these instead, search again asking for it.
   */
  also_available: z.array(z.string()).optional(),
  /** Total price for the whole party, if known up front. null = priced at the venue. */
  price: MoneySchema.nullable(),
  deposit: DepositTermsSchema.nullable(),
  cancellation_policy: CancellationPolicySchema,
});
export type Slot = z.infer<typeof SlotSchema>;

/** Opening periods in venue-local time, keyed mon … sun. An empty or missing day is closed. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** What an agent needs to describe a venue before searching: hours and booking rules. */
export const VenueInfoSchema = z.object({
  opening_hours: z.record(
    z.enum(WEEKDAYS),
    z.array(z.object({ open: LocalTimeSchema, close: z.string() })),
  ),
  /** Dates (YYYY-MM-DD) the venue is closed, e.g. holidays. */
  closed_dates: z.array(DateSchema).default([]),
  /** Earliest bookable start, in minutes from now. */
  min_lead_minutes: z.number().int().nullable().default(null),
  /** How many days ahead bookings are accepted. */
  max_days_ahead: z.number().int().nullable().default(null),
  /**
   * Weekly working hours of resources that have their own (resource id → weekday → periods).
   * Resources not listed work whenever the venue is open. Time off is never exposed.
   */
  staff_hours: z
    .record(
      z.string(),
      z.record(z.enum(WEEKDAYS), z.array(z.object({ open: LocalTimeSchema, close: z.string() }))),
    )
    .default({}),
});
export type VenueInfo = z.infer<typeof VenueInfoSchema>;

export const AvailabilityQuerySchema = z
  .object({
    venue_id: z
      .string()
      .optional()
      .describe('Venue to search. May be omitted when the server serves a single venue.'),
    date: DateSchema,
    party_size: PartySizeSchema,
    time_from: LocalTimeSchema.optional().describe('Earliest start time (inclusive), HH:MM'),
    time_to: LocalTimeSchema.optional().describe('Latest start time (inclusive), HH:MM'),
    offering_id: z.string().optional(),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'What the resource must match, case-insensitive: a staff member by name or id (e.g. ["Kari"]), or a feature such as ["outdoor"]',
      ),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .refine((q) => !q.time_from || !q.time_to || q.time_from <= q.time_to, {
    message: 'time_from must be <= time_to',
    path: ['time_from'],
  });
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;
export type AvailabilityQueryInput = z.input<typeof AvailabilityQuerySchema>;

// ---------------------------------------------------------------------------
// Booking (a hold is a booking in status `held`)
// ---------------------------------------------------------------------------

/**
 * Lifecycle: `held` → `confirmed` → `cancelled`, or `held` → `expired` / `cancelled`.
 * UCP mapping (see adapter-ucp): held → `incomplete`/`ready_for_complete`,
 * confirmed → `completed`, cancelled/expired → `canceled`.
 */
export const BookingStatusSchema = z.enum(['held', 'confirmed', 'cancelled', 'expired']);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const PaymentStatusSchema = z.enum(['not_required', 'due_at_venue', 'pending', 'paid']);

export const BookingSchema = z.object({
  booking_id: z.string(),
  status: BookingStatusSchema,
  venue_id: z.string(),
  /** Snapshot of the slot at hold time, including the policy/deposit the user agreed to. */
  slot: SlotSchema,
  customer: CustomerSchema.nullable(),
  notes: z.string().nullable(),
  /** Set while `held`: the hold is released automatically at this instant (UCP `expires_at`). */
  expires_at: DateTimeSchema.nullable(),
  /** Set once `confirmed`. Maps to UCP `confirmation.id`. */
  confirmation_code: z.string().nullable(),
  payment: z.object({
    status: PaymentStatusSchema,
    amount: MoneySchema.nullable(),
    reference: z.string().nullable(),
  }),
  cancellation: z
    .object({
      reason: z.string().nullable(),
      fee: MoneySchema.nullable(),
      refund: MoneySchema.nullable(),
    })
    .nullable(),
  created_at: DateTimeSchema,
  updated_at: DateTimeSchema,
  confirmed_at: DateTimeSchema.nullable(),
  cancelled_at: DateTimeSchema.nullable(),
});
export type Booking = z.infer<typeof BookingSchema>;

/** A booking in `held` state. Kept as a named concept for readability. */
export type Hold = Booking & { status: 'held'; expires_at: string };

// ---------------------------------------------------------------------------
// Service inputs (validated at the BookingService boundary)
// ---------------------------------------------------------------------------

export const HoldInputSchema = z.object({
  slot_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
  customer: CustomerSchema.optional(),
  notes: z.string().max(500).optional(),
});
export type HoldInput = z.input<typeof HoldInputSchema>;

export const ConfirmInputSchema = z.object({
  booking_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
  // EXTENSION: explicit user consent flag. Never auto-confirm.
  user_confirmed: z.boolean(),
  customer: CustomerSchema.optional(),
  payment_token: z.string().min(1).optional(),
});
export type ConfirmInput = z.input<typeof ConfirmInputSchema>;

export const UpdateInputSchema = z
  .object({
    booking_id: z.string().min(1),
    idempotency_key: IdempotencyKeySchema,
    customer: CustomerSchema.optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine((u) => u.customer !== undefined || u.notes !== undefined, {
    message: 'Nothing to update: provide customer and/or notes',
  });
export type UpdateInput = z.input<typeof UpdateInputSchema>;

export const CancelInputSchema = z.object({
  booking_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
  /** Required (true) to cancel a *confirmed* booking; releasing a hold does not need it. */
  user_confirmed: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});
export type CancelInput = z.input<typeof CancelInputSchema>;

export const RescheduleInputSchema = z.object({
  booking_id: z.string().min(1),
  /** A slot for the same service and party size, from search_availability. */
  slot_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
  /** Required (true): the user approved the new time, price and cancellation terms. */
  user_confirmed: z.boolean().optional(),
});
export type RescheduleInput = z.input<typeof RescheduleInputSchema>;
