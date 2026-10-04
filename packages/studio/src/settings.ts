/**
 * What a business owner sets up in Studio: profile, opening hours, services, staff and rules.
 * Deliberately in owner terms (prices in minor units, fees as a percentage of the price, one
 * cancellation rule for the whole business) so setup takes minutes. Hosted OpenBooking turns it
 * into a provider configuration.
 */
import { AddressSchema, CurrencySchema, DateSchema } from '@openbooking/core';
import * as z from 'zod';

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** Forms send '' for empty optional fields; treat that as "not set". */
const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    schema.optional(),
  );

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes (max 40)');

const Clock = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Expected HH:MM');

export const OpeningPeriodSchema = z
  .object({ open: Clock, close: Clock })
  .refine((p) => p.open < p.close, { message: 'Opening time must be before closing time' });

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const BusinessSettingsSchema = z
  .object({
    profile: z.object({
      name: z.string().trim().min(1).max(120),
      description: optional(z.string().trim().max(1000)),
      /** e.g. hair_salon, barber, physiotherapist, therapist, personal_trainer, tutor, other. */
      category: z.string().trim().max(60).default('other'),
      timezone: z.string().refine(isTimeZone, 'Unknown time zone'),
      currency: CurrencySchema,
      phone_number: optional(z.string().trim().max(40)),
      /** Public contact email; customers' replies go here. */
      email: optional(z.email()),
      website: optional(z.url()),
      address: AddressSchema.default({}),
    }),
    /** Keyed by weekday; an empty list means closed that day. */
    opening_hours: z.object(
      Object.fromEntries(
        WEEKDAY_KEYS.map((d) => [d, z.array(OpeningPeriodSchema).max(4).default([])]),
      ) as Record<WeekdayKey, z.ZodDefault<z.ZodArray<typeof OpeningPeriodSchema>>>,
    ),
    closed_dates: z.array(DateSchema).max(366).default([]),
    services: z
      .array(
        z.object({
          id: Id,
          name: z.string().trim().min(1).max(80),
          description: optional(z.string().trim().max(500)),
          duration_minutes: z.number().int().min(5).max(600),
          /** Minor units (øre/cents). null = price on request / paid at the business. */
          price: z.number().int().min(0).nullable(),
          /** Staff who do this service. Empty = everyone. */
          staff_ids: z.array(Id).default([]),
        }),
      )
      .max(100),
    staff: z
      .array(
        z.object({
          id: Id,
          name: z.string().trim().min(1).max(80),
          /** Google calendar that holds this person's appointments (when connected). */
          google_calendar_id: optional(z.string().max(300)),
        }),
      )
      .max(50),
    cancellation: z.object({
      /** Free cancellation until this many hours before. null = never free. */
      free_until_hours_before: z.number().int().min(0).max(720).nullable(),
      /** Fee for a later cancellation, as a percentage of the service price. */
      late_fee_percent: z.number().int().min(0).max(100),
      no_show_fee_percent: z.number().int().min(0).max(100),
    }),
    booking_rules: z.object({
      slot_interval_minutes: z.number().int().min(5).max(120),
      /** Break between appointments with the same person. */
      buffer_minutes: z.number().int().min(0).max(120),
      /** Earliest booking, in minutes from now. */
      min_lead_minutes: z.number().int().min(0).max(10_080),
      max_days_ahead: z.number().int().min(1).max(365),
    }),
    notifications: z.object({
      /** Where "new booking" emails go. Defaults to the account email. */
      owner_email: optional(z.email()),
      email_owner: z.boolean().default(true),
      email_customers: z.boolean().default(true),
    }),
    /** Listed in the OpenBooking app (find_business) for every AI assistant. */
    listed: z.boolean().default(true),
  })
  .superRefine((s, ctx) => {
    const staff = new Set(s.staff.map((p) => p.id));
    if (staff.size !== s.staff.length) {
      ctx.addIssue({ code: 'custom', path: ['staff'], message: 'Staff ids must be unique' });
    }
    if (new Set(s.services.map((x) => x.id)).size !== s.services.length) {
      ctx.addIssue({ code: 'custom', path: ['services'], message: 'Service ids must be unique' });
    }
    s.services.forEach((svc, i) =>
      svc.staff_ids.forEach((id) => {
        if (!staff.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', i, 'staff_ids'],
            message: `Unknown staff member "${id}"`,
          });
        }
      }),
    );
  });
export type BusinessSettings = z.infer<typeof BusinessSettingsSchema>;
export type BusinessSettingsInput = z.input<typeof BusinessSettingsSchema>;

/**
 * A Google Calendar connection as Studio shows it. Actions are paths under the Studio API (`/api`)
 * that the UI POSTs to; the host serves them.
 */
export interface GoogleIntegrationView {
  /** False when the server has no Google OAuth client configured. */
  available: boolean;
  connected: boolean;
  email?: string;
  /** Set when the connection broke (e.g. access revoked) and needs reconnecting. */
  error?: string;
  calendars?: Array<{ id: string; summary: string; primary: boolean }>;
  /** POST → `{ url }` to send the owner to Google's consent screen. */
  connect_path: string;
  disconnect_path: string;
}

export interface SettingsView {
  settings: BusinessSettings;
  /** Links the owner shares: booking page, "Book me through ChatGPT", the MCP endpoint. */
  links?: Array<{ label: string; url: string; hint?: string }>;
  integrations?: { google?: GoogleIntegrationView };
  /** Account email (hosted). */
  account?: {
    email: string;
    /** false while the owner hasn't confirmed their email (hosted with email sending). */
    email_verified?: boolean;
    /** POST here (Studio API path) to send the confirmation email again. */
    resend_verification_path?: string;
  };
}

/** Where Studio reads and saves settings. Hosted OpenBooking implements it per business. */
export interface StudioSettingsAdapter {
  get(): Promise<SettingsView>;
  /** `settings` is already validated against {@link BusinessSettingsSchema}. */
  update(settings: BusinessSettings): Promise<SettingsView>;
}
