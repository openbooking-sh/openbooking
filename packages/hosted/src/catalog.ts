/**
 * Business settings (owner terms) → provider configuration (engine terms), and the starting
 * settings a new business gets at sign-up.
 */
import type {
  MemoryProviderConfig,
  OfferingConfig,
  VenueConfig,
} from '@openbooking-sh/provider-memory';
import {
  BusinessSettingsSchema,
  WEEKDAY_KEYS,
  type BusinessSettings,
  type BusinessSettingsInput,
} from '@openbooking-sh/studio';
import { slugify, type Business } from './business';

export function venueConfig(business: Business, pageUrl?: string): VenueConfig {
  const s = business.settings;
  const p = s.profile;
  const c = s.cancellation;
  const percentOf = (price: number | null, pct: number) =>
    price && pct ? Math.round((price * pct) / 100) : null;

  const offerings: OfferingConfig[] = s.services.map((svc) => ({
    id: svc.id,
    venue_id: business.id,
    name: svc.name,
    ...(svc.description ? { description: svc.description } : {}),
    duration_minutes: svc.duration_minutes,
    price_per_person: svc.price === null ? null : { amount: svc.price, currency: p.currency },
    resource_kinds: ['staff'],
    ...(svc.staff_ids.length ? { resource_ids: svc.staff_ids } : {}),
    cancellation: {
      refundability: c.free_until_hours_before === null ? 'non_refundable' : 'refundable',
      free_until_hours_before: c.free_until_hours_before,
      late_fee_per_person: percentOf(svc.price, c.late_fee_percent),
      no_show_fee_per_person: percentOf(svc.price, c.no_show_fee_percent),
    },
    // Deposits need online payments, which come later (Stripe payment links).
    deposit: null,
  }));

  return {
    venue: {
      id: business.id,
      name: p.name,
      timezone: p.timezone,
      currency: p.currency,
      ...(Object.values(p.address).some(Boolean) ? { address: p.address } : {}),
      ...(p.phone_number ? { phone_number: p.phone_number } : {}),
      ...((p.website ?? pageUrl) ? { url: p.website ?? pageUrl } : {}),
      ...(p.description ? { description: p.description } : {}),
    },
    currency: p.currency,
    resources: s.staff.map((m) => ({
      id: m.id,
      venue_id: business.id,
      kind: 'staff',
      name: m.name,
      capacity: { min: 1, max: 1 },
      // The id makes "with Maria" exact for the booking page; the first name lets agents pass
      // preferences like ["maria"].
      tags: [...new Set([m.id, slugify(m.name.split(/\s+/)[0] ?? m.name)])],
    })),
    offerings,
    opening_hours: Object.fromEntries(
      WEEKDAY_KEYS.map((key, weekday) => [weekday, s.opening_hours[key]]),
    ),
    closed_dates: s.closed_dates,
    slot_interval_minutes: s.booking_rules.slot_interval_minutes,
    buffer_minutes: s.booking_rules.buffer_minutes,
    min_lead_minutes: s.booking_rules.min_lead_minutes,
    max_days_ahead: s.booking_rules.max_days_ahead,
  };
}

export function providerConfig(business: Business, pageUrl?: string): MemoryProviderConfig {
  const s = business.settings;
  return {
    name: s.profile.name,
    ...(s.profile.description ? { description: s.profile.description } : {}),
    venues: [venueConfig(business, pageUrl)],
  };
}

// ---------------------------------------------------------------------------
// Sign-up templates
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  'hair_salon',
  'barber',
  'beauty',
  'physiotherapist',
  'therapist',
  'personal_trainer',
  'tutor',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** [name, minutes, price in NOK] */
type Starter = [string, number, number];

const STARTERS: Record<Category, Starter[]> = {
  hair_salon: [
    ['Haircut', 45, 650],
    ['Color & cut', 120, 1450],
    ['Blow dry', 30, 400],
  ],
  barber: [
    ['Haircut', 30, 450],
    ['Beard trim', 20, 300],
    ['Haircut & beard', 45, 650],
  ],
  beauty: [
    ['Manicure', 45, 550],
    ['Pedicure', 60, 650],
    ['Brows', 20, 300],
  ],
  physiotherapist: [
    ['First consultation', 60, 850],
    ['Follow-up treatment', 45, 650],
  ],
  therapist: [
    ['First session', 60, 1200],
    ['Session', 50, 1100],
  ],
  personal_trainer: [
    ['Intro session', 30, 0],
    ['PT session', 60, 800],
  ],
  tutor: [
    ['Lesson', 60, 600],
    ['Double lesson', 120, 1100],
  ],
  other: [['Appointment', 60, 0]],
};

const SATURDAYS: ReadonlySet<Category> = new Set(['hair_salon', 'barber', 'beauty']);

export interface StarterInput {
  name: string;
  /** The owner's name: the first staff member. */
  ownerName: string;
  category: Category;
  timezone?: string;
  currency?: string;
  city?: string;
  country?: string;
}

/**
 * Sensible defaults for a new business so it is bookable a minute after sign-up: one staff member
 * (the owner), typical services for the category, weekday hours and a 24-hour cancellation rule.
 * Example prices are only filled in for NOK; elsewhere the owner sets them.
 */
export function starterSettings(input: StarterInput): BusinessSettings {
  const currency = input.currency ?? 'NOK';
  const weekday = [{ open: '09:00', close: '17:00' }];
  const settings: BusinessSettingsInput = {
    profile: {
      name: input.name,
      category: input.category,
      timezone: input.timezone ?? 'Europe/Oslo',
      currency,
      address: {
        ...(input.city ? { address_locality: input.city } : {}),
        ...(input.country ? { address_country: input.country } : {}),
      },
    },
    opening_hours: {
      mon: weekday,
      tue: weekday,
      wed: weekday,
      thu: weekday,
      fri: weekday,
      sat: SATURDAYS.has(input.category) ? [{ open: '10:00', close: '15:00' }] : [],
      sun: [],
    },
    closed_dates: [],
    staff: [{ id: slugify(input.ownerName), name: input.ownerName }],
    services: STARTERS[input.category].map(([name, minutes, nok]) => ({
      id: slugify(name),
      name,
      duration_minutes: minutes,
      price: currency === 'NOK' && nok > 0 ? nok * 100 : null,
      staff_ids: [],
    })),
    cancellation: { free_until_hours_before: 24, late_fee_percent: 50, no_show_fee_percent: 100 },
    booking_rules: {
      slot_interval_minutes: 15,
      buffer_minutes: SATURDAYS.has(input.category) ? 10 : 0,
      min_lead_minutes: 60,
      max_days_ahead: 60,
    },
    notifications: { email_owner: true, email_customers: true },
    listed: true,
  };
  return BusinessSettingsSchema.parse(settings);
}
