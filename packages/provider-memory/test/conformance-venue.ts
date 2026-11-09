/**
 * A venue for running the conformance suite with `combinedTables`: four 4-tops in a row that can be
 * pushed together as neighbouring pairs (f1+f2, f2+f3, f3+f4), so a party of 6 can only ever sit at
 * joined tables (two bookings per time) and neighbouring pairs compete for a table, plus a 2-top
 * for the ordinary checks. Shared by the memory and Postgres runs.
 */
import type { Resource } from '@openbooking-sh/core';
import type { VenueConfig } from '../src';

const table = (id: string, min: number, max: number): Resource => ({
  id,
  venue_id: 'r',
  kind: 'table',
  name: `Table ${id.toUpperCase()}`,
  capacity: { min, max },
  tags: [],
});

export function conformanceVenue(): VenueConfig {
  return {
    venue: { id: 'r', name: 'Conformance Bistro', timezone: 'Europe/Oslo', currency: 'NOK' },
    currency: 'NOK',
    resources: [
      table('s1', 1, 2),
      table('f1', 1, 4),
      table('f2', 1, 4),
      table('f3', 1, 4),
      table('f4', 1, 4),
    ],
    table_combinations: [
      { resource_ids: ['f1', 'f2'], min_party_size: 5, max_party_size: 8 },
      // Shares f2 with the pair before it and f3 with the pair after: a store that looked at one
      // table only would give f2 or f3 to two bookings.
      { resource_ids: ['f2', 'f3'], min_party_size: 5, max_party_size: 8 },
      { resource_ids: ['f3', 'f4'], min_party_size: 5, max_party_size: 8 },
    ],
    offerings: [
      {
        id: 'dinner',
        venue_id: 'r',
        name: 'Dinner',
        duration_minutes: 90,
        price_per_person: null,
        resource_kinds: ['table'],
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: 24,
          late_fee_per_person: null,
          no_show_fee_per_person: null,
        },
        deposit: null,
      },
    ],
    // Wednesday 2026-10-14; the conformance clock is two days earlier.
    opening_hours: { 3: [{ open: '17:00', close: '23:00' }] },
    slot_interval_minutes: 30,
    buffer_minutes: 15,
    min_lead_minutes: 30,
    max_days_ahead: 30,
  };
}

/** The options both runs share (they add `create`). */
export const conformanceRun = {
  now: new Date('2026-10-12T08:00:00Z'),
  query: { date: '2026-10-14', party_size: { total: 2 } },
  combinedTables: { query: { date: '2026-10-14', party_size: { total: 6 } } },
};
