import type { Money, Offering, Resource, Venue } from '@openbooking/core';

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
  /** Restrict to these weekdays (0 = Sunday). Defaults to all opening days. */
  weekdays?: number[];
  /** Restrict start times to this local window. */
  first_start?: string;
  last_start?: string;
  cancellation: CancellationRule;
  deposit: DepositRule | null;
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
