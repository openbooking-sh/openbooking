/**
 * OpenBooking → USP mapping for the catalog and availability.
 *
 * What we cannot say honestly we leave out rather than invent: USP makes most descriptive members
 * optional, and a platform shows the buyer whatever we send. See docs/USP-MAPPING (website repo)
 * for the decisions behind each row.
 */
import {
  time,
  type Offering,
  type Resource,
  type Slot,
  type Venue,
  type VenueInfo,
} from '@openbooking-sh/core';

/** Optional per-offering overrides until providers expose catalog-level policies themselves. */
export interface ServiceDetails {
  type: string;
  description: string;
  /** Rescheduling is advertised only when the adapter serves the reschedule endpoint. */
  reschedule: boolean;
}

export interface ServiceContext {
  businessId: string;
  /** More than one venue → ids carry the venue so they stay unique. */
  multiVenue: boolean;
  venue: Venue;
  resources: Resource[];
  details?: Partial<ServiceDetails>;
  reschedule: boolean;
}

/** `PT45M`, `PT1H30M`, `PT2H`: ISO 8601 durations as USP writes them. */
export function isoDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `PT${h ? `${h}H` : ''}${m || !h ? `${m}M` : ''}`;
}

export const serviceId = (venueId: string, offeringId: string, multiVenue: boolean) =>
  multiVenue ? `${venueId}:${offeringId}` : offeringId;

export function parseServiceId(
  id: string,
  venues: Venue[],
): { venueId: string; offeringId: string } | null {
  if (venues.length === 1) return { venueId: venues[0]!.id, offeringId: id };
  for (const v of venues) {
    if (id.startsWith(`${v.id}:`)) return { venueId: v.id, offeringId: id.slice(v.id.length + 1) };
  }
  return null;
}

const staffOf = (resources: Resource[]) =>
  resources.filter((r) => r.kind !== 'table' && r.kind !== 'room');
const tablesOf = (resources: Resource[]) => resources.filter((r) => r.kind === 'table');

/** USP `Service` for one offering at one venue. */
export function toService(offering: Offering, ctx: ServiceContext) {
  const { venue, resources } = ctx;
  const currency = offering.price_per_person?.currency ?? venue.currency;
  if (!currency) {
    throw new Error(`Venue ${venue.id} has no currency; USP pricing requires one.`);
  }
  const tables = tablesOf(resources);
  const staff = staffOf(resources);
  const type = ctx.details?.type ?? (tables.length ? 'reservation' : 'appointment');
  const description = ctx.details?.description ?? offering.description;

  // USP forces `free` whenever nothing is payable, so a service priced at the venue (or at an
  // unknown price) must say "payment at service" instead of pretending to be free. OpenBooking has
  // no notion of a free offering: a null price means "settled at the venue", never "no charge".
  const priced = offering.price_per_person !== null;
  const pricing = priced
    ? {
        model: 'per_person',
        amount: offering.price_per_person!.amount,
        currency: offering.price_per_person!.currency,
      }
    : { model: 'variable', currency };

  return {
    id: serviceId(venue.id, offering.id, ctx.multiVenue),
    business_id: ctx.businessId,
    name: offering.name,
    ...(description ? { description: { plain: description } } : {}),
    type,
    duration: { fixed: isoDuration(offering.duration_minutes) },
    pricing,
    channel: { type: 'at_business_location' },
    locations: [
      {
        id: venue.id,
        name: venue.name,
        ...(venue.address ? { address: addressLine(venue.address) } : {}),
      },
    ],
    ...(staff.length
      ? {
          resources: [
            {
              type: 'staff',
              selectable: true,
              options: staff.map((r) => ({ id: r.id, name: r.name })),
            },
          ],
        }
      : {}),
    // `reservation` services must declare capacity (the party sizes a table can take).
    ...(type === 'reservation' && tables.length
      ? {
          capacity: {
            min: Math.min(...tables.map((t) => t.capacity.min)),
            max: Math.max(...tables.map((t) => t.capacity.max)),
          },
        }
      : {}),
    policies: {
      // Cancelling is allowed until the booking starts; the fee depends on the slot's terms, which
      // are shown on each booking (see the cancellation_terms extension).
      cancellation: { allowed: true, no_cancellation_after: 'PT0S' },
      rescheduling: { allowed: ctx.reschedule },
      confirmation_mode: 'auto',
      requires_payment: true,
      payment_timing: 'at_service',
    },
    status: 'active',
  };
}

const addressLine = (a: NonNullable<Venue['address']>) =>
  [
    a.street_address,
    [a.postal_code, a.address_locality].filter(Boolean).join(' '),
    a.address_region,
  ]
    .filter(Boolean)
    .join(', ');

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Group days that share the same period so `opening_hours` stays short. */
export function openingHours(info: VenueInfo) {
  const byPeriod = new Map<string, { opens: string; closes: string; days: string[] }>();
  DAY_KEYS.forEach((key, i) => {
    for (const p of info.opening_hours[key] ?? []) {
      const k = `${p.open}-${p.close}`;
      const entry = byPeriod.get(k) ?? { opens: p.open, closes: p.close, days: [] };
      entry.days.push(DAY_NAMES[i]!);
      byPeriod.set(k, entry);
    }
  });
  return [...byPeriod.values()].map((e) => ({
    day_of_week: e.days,
    opens: e.opens,
    closes: e.closes,
  }));
}

/** USP `TimeSlot`: one per resource (the spec requires a slot for each resource combination). */
export function toTimeSlot(slot: Slot, venue: Venue, multiVenue: boolean) {
  const minutes = Math.round((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000);
  return {
    id: slot.slot_id,
    service_id: serviceId(venue.id, slot.offering.id, multiVenue),
    start: slot.start,
    end: slot.end,
    duration: isoDuration(minutes),
    state: 'available',
    ...(slot.resource
      ? {
          resources: [
            {
              ...(slot.resource.id ? { id: slot.resource.id } : {}),
              type: slot.resource.kind,
              name: slot.resource.label,
            },
          ],
        }
      : {}),
    location: { id: venue.id, name: venue.name },
    ...(slot.price
      ? {
          pricing: {
            amount: slot.price.amount,
            currency: slot.price.currency,
            label: `Total for ${slot.party_size.total} ${slot.party_size.total === 1 ? 'guest' : 'guests'}`,
          },
        }
      : {}),
  };
}

/** Local calendar days (venue time) an instant range touches, for searching day by day. */
export function daysBetween(from: string, toInclusive: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= toInclusive && days.length < 400; d = time.addDays(d, 1)) days.push(d);
  return days;
}
