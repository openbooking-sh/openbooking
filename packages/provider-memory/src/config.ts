import type { Money, Offering, Resource, Venue } from '@openbooking-sh/core';

/** Opening period in venue-local time. `close` may be `24:00`. */
export interface OpeningPeriod {
  open: string;
  close: string;
}

export interface CancellationRule {
  refundability: 'refundable' | 'partially_refundable' | 'non_refundable';
  /** Free cancellation until this many hours before start. null = never free. */
  free_until_hours_before: number | null;
  /** Fee per guest when cancelling after the free window (minor units). */
  late_fee_per_person: number | null;
  /** Fee per guest for a no-show (minor units). */
  no_show_fee_per_person: number | null;
}

export interface DepositRule {
  /** Deposit applies from this party size upwards (1 = always). */
  min_party_size: number;
  /** Minor units per guest. */
  amount_per_person: number;
  due: 'at_confirmation' | 'at_venue';
}

export interface OfferingConfig extends Offering {
  /** Resource kinds this offering can use, e.g. ["table"]. */
  resource_kinds: string[];
  /** Only these resources may take this offering (e.g. the staff who do colour). Default: any. */
  resource_ids?: string[];
  /** Restrict to these weekdays (0 = Sunday). Defaults to all opening days. */
  weekdays?: number[];
  /** Restrict start times to this local window. */
  first_start?: string;
  last_start?: string;
  cancellation: CancellationRule;
  deposit: DepositRule | null;
  /**
   * Table time that depends on the party, e.g. `[{ min_party_size: 1, duration_minutes: 90 },
   * { min_party_size: 6, duration_minutes: 150 }]`. The entry with the largest `min_party_size`
   * that is at most the party wins; a party smaller than every entry uses `duration_minutes`,
   * which stays the default (and what listings show).
   */
  duration_by_party?: DurationByParty[];
}

export interface DurationByParty {
  min_party_size: number;
  duration_minutes: number;
}

/** How long this offering takes for this party. The one place that decides it. */
export function durationFor(o: OfferingConfig, party: number): number {
  let best: DurationByParty | undefined;
  for (const d of o.duration_by_party ?? []) {
    if (d.min_party_size <= party && (!best || d.min_party_size > best.min_party_size)) best = d;
  }
  return best ? best.duration_minutes : o.duration_minutes;
}

/**
 * A shift (lunch, dinner). When a venue lists service periods, bookings can only start inside one
 * of them (on its weekdays), and still within opening hours.
 */
export interface ServicePeriod {
  name: string;
  /** Restrict to these weekdays (0 = Sunday). Default: every day. */
  weekdays?: number[];
  /** Starts are allowed from `open` up to (not including) `close`, venue-local `HH:mm`. */
  open: string;
  close: string;
  /** Fixed start times (`HH:mm`) instead of every `slot_interval_minutes`. */
  seatings?: string[];
  /** Overrides the venue's pacing cap for starts in this period. */
  max_guests_per_interval?: number;
  /**
   * Most guests bookable online across the whole period (counted by start time). The rest of the
   * room is held back for walk-ins and phone bookings.
   */
  max_online_guests?: number;
}

/** Cap on guests starting together, so the kitchen is not hit by every table at once. */
export interface Pacing {
  max_guests_per_interval: number;
  /** Length of the window in minutes, aligned to midnight. Default 15. */
  interval_minutes?: number;
}

/**
 * A staff member's (or any resource's) own schedule, within the venue's opening hours. A resource
 * without a schedule works whenever the venue is open.
 */
export interface ResourceSchedule {
  /**
   * Weekly working hours in venue-local time, keyed by weekday 0 (Sunday) … 6 (Saturday). When
   * set, days that are missing or empty are days off. Only times inside opening hours count.
   */
  hours?: Partial<Record<number, OpeningPeriod[]>>;
  /**
   * Time off in venue-local time. `YYYY-MM-DD` is a whole day (an end date is included);
   * `YYYY-MM-DDTHH:mm` is an exact time (the end is excluded).
   */
  time_off?: Array<{ start: string; end: string; reason?: string }>;
}

export interface VenueConfig {
  venue: Venue;
  currency: string;
  resources: Resource[];
  offerings: OfferingConfig[];
  /** Keyed by weekday 0 (Sunday) … 6 (Saturday). Missing/empty = closed. */
  opening_hours: Partial<Record<number, OpeningPeriod[]>>;
  /** Dates (`YYYY-MM-DD`) the venue is closed. */
  closed_dates?: string[];
  /** Working hours and time off per resource id (e.g. each stylist). */
  schedules?: Record<string, ResourceSchedule>;
  /** Shifts with optional fixed seatings, pacing and a walk-in reserve. Default: none. */
  service_periods?: ServicePeriod[];
  /** Default cap on guests per start interval (held + confirmed bookings). Default: none. */
  pacing?: Pacing;
  slot_interval_minutes: number;
  /** Cleaning/turnover time between bookings on the same resource. */
  buffer_minutes: number;
  /** Earliest bookable start relative to now. */
  min_lead_minutes: number;
  /** How far ahead bookings are accepted. */
  max_days_ahead: number;
}

export interface MemoryProviderConfig {
  name: string;
  description?: string;
  venues: VenueConfig[];
}

export const money = (amount: number, currency: string): Money => ({ amount, currency });
