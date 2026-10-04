import type { BusyInterval, BusySource } from '@openbooking/provider-memory';
import type { GoogleCalendarClient } from './client';
import { GoogleAuthError } from './oauth';

export interface CalendarSyncConfig {
  /** Calendar for staff without their own; usually 'primary'. */
  defaultCalendarId: string;
  /** resource (staff) id → Google calendar id. */
  staffCalendars?: Record<string, string>;
}

/** The calendar that represents a resource. */
export function calendarFor(config: CalendarSyncConfig, resourceId: string | undefined): string {
  return (resourceId && config.staffCalendars?.[resourceId]) || config.defaultCalendarId;
}

export interface GoogleBusySourceOptions {
  client: GoogleCalendarClient;
  config: () => CalendarSyncConfig | Promise<CalendarSyncConfig>;
  /**
   * Called when Google says the connection is gone; availability then ignores Google (fail open)
   * instead of blocking every booking forever.
   */
  onAuthError?: (error: GoogleAuthError) => void;
  /**
   * How long a busy-time answer is reused, per exact (calendars, range) key. Default 30s. Searches
   * ask for a whole day and hit the cache when an agent pages through times; holds ask for one
   * slot's range, so they are effectively always fresh. 0 disables the cache.
   */
  cacheMs?: number;
}

/**
 * Busy times from Google Calendar as a provider-memory {@link BusySource}: a staff member is busy
 * whenever their calendar (or the default calendar) has an event that blocks time. Events
 * OpenBooking created for its own bookings are ignored (the booking store already blocks those),
 * so on a calendar shared by several staff, one person's booking doesn't block the others.
 * One events.list per calendar per lookup.
 *
 * Transient Google errors propagate, so the provider fails closed (retryable error) rather than
 * offering times that may be taken. A lost connection fails open and reports via `onAuthError`.
 */
export function googleBusySource(opts: GoogleBusySourceOptions): BusySource {
  const cacheMs = opts.cacheMs ?? 30_000;
  const cache = new Map<
    string,
    { at: number; busy: Map<string, Array<{ start: Date; end: Date }>> }
  >();

  return async (q) => {
    const config = await opts.config();
    const calendarOf = new Map(q.resource_ids.map((id) => [id, calendarFor(config, id)]));
    const calendars = [...new Set(calendarOf.values())].sort();
    if (!calendars.length) return [];

    const now = q.now.getTime();
    for (const [k, v] of cache) if (now - v.at >= cacheMs) cache.delete(k);
    const key = `${calendars.join(',')}|${q.from_ms}|${q.to_ms}`;
    let busy = cacheMs > 0 ? cache.get(key)?.busy : undefined;
    if (!busy) {
      try {
        const from = new Date(q.from_ms);
        const to = new Date(q.to_ms);
        const lists = await Promise.all(
          calendars.map((id) => opts.client.listBusyEvents(id, from, to)),
        );
        busy = new Map(calendars.map((id, i) => [id, lists[i]!]));
      } catch (e) {
        if (e instanceof GoogleAuthError) {
          opts.onAuthError?.(e);
          return [];
        }
        throw e;
      }
      if (cacheMs > 0) cache.set(key, { at: now, busy });
    }

    const out: BusyInterval[] = [];
    for (const [resourceId, calendarId] of calendarOf) {
      for (const b of busy.get(calendarId) ?? []) {
        out.push({ resource_id: resourceId, start_ms: b.start.getTime(), end_ms: b.end.getTime() });
      }
    }
    return out;
  };
}
