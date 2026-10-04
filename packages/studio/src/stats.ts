import { time, type Booking } from '@openbooking/core';
import type { ActivityEntry } from './activity';

export interface AgentRow {
  agent: string;
  calls: number;
  holds: number;
  bookings: number;
  errors: number;
  last_seen: string;
}

export interface Overview {
  today: string;
  kpis: {
    upcoming_confirmed: number;
    confirmed_today: number;
    holds_open: number;
    cancelled_7d: number;
    agent_calls_24h: number;
    error_rate_24h: number;
    hold_to_booking_rate: number | null;
  };
  agents: AgentRow[];
}

const DAY = 86_400_000;

/** Dashboard numbers from the current bookings plus the activity log. */
export function computeOverview(
  bookings: Booking[],
  activity: readonly ActivityEntry[],
  now: Date,
  timezone: string,
): Overview {
  const today = time.localDate(now, timezone);
  const nowMs = now.getTime();

  const upcoming = bookings.filter(
    (b) => b.status === 'confirmed' && new Date(b.slot.start).getTime() >= nowMs,
  ).length;
  const confirmedToday = bookings.filter(
    (b) => b.confirmed_at && time.localDate(new Date(b.confirmed_at), timezone) === today,
  ).length;
  const holds = bookings.filter((b) => b.status === 'held').length;
  const cancelled7d = bookings.filter(
    (b) =>
      b.status === 'cancelled' &&
      b.cancelled_at &&
      nowMs - new Date(b.cancelled_at).getTime() < 7 * DAY,
  ).length;

  const recent = activity.filter(
    (e) => nowMs - new Date(e.at).getTime() < DAY && e.protocol !== 'studio',
  );
  const errors = recent.filter((e) => !e.ok).length;
  const holdsOk = recent.filter((e) => e.operation === 'hold' && e.ok && !e.replayed).length;
  const confirmsOk = recent.filter((e) => e.operation === 'confirm' && e.ok && !e.replayed).length;

  const byAgent = new Map<string, AgentRow>();
  for (const e of activity) {
    // Studio counts as a booking channel (staff phone/walk-in bookings); its read-only calls
    // are already filtered out by recordActivity.
    const row = byAgent.get(e.agent) ?? {
      agent: e.agent,
      calls: 0,
      holds: 0,
      bookings: 0,
      errors: 0,
      last_seen: e.at,
    };
    row.calls++;
    if (!e.ok) row.errors++;
    if (e.ok && !e.replayed && e.operation === 'hold') row.holds++;
    if (e.ok && !e.replayed && e.operation === 'confirm') row.bookings++;
    if (e.at > row.last_seen) row.last_seen = e.at;
    byAgent.set(e.agent, row);
  }

  return {
    today,
    kpis: {
      upcoming_confirmed: upcoming,
      confirmed_today: confirmedToday,
      holds_open: holds,
      cancelled_7d: cancelled7d,
      agent_calls_24h: recent.length,
      error_rate_24h: recent.length ? errors / recent.length : 0,
      hold_to_booking_rate: holdsOk ? Math.min(1, confirmsOk / holdsOk) : null,
    },
    agents: [...byAgent.values()].sort((a, b) => b.bookings - a.bookings || b.calls - a.calls),
  };
}
