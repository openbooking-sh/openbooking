import type { BookingEvent, BookingService } from '@openbooking-sh/core';

export interface ActivityEntry {
  id: number;
  at: string;
  operation: BookingEvent['operation'];
  ok: boolean;
  booking_id?: string;
  status?: string;
  error_code?: string;
  replayed?: boolean;
  agent: string;
  protocol: string;
  client?: string;
}

export interface ActivityQuery {
  /** Only entries with id > after (for polling). */
  after?: number;
  booking_id?: string;
  limit?: number;
}

/**
 * Where the Studio keeps booking activity (who did what, when) and the channel each booking came
 * through. Memory by default; `@openbooking-sh/postgres` makes it durable.
 */
export interface ActivityLog {
  /** Append an entry (the log assigns `id`) and update booked-via attribution. */
  add(entry: Omit<ActivityEntry, 'id'>): Promise<ActivityEntry>;
  /** Newest first. */
  list(query?: ActivityQuery): Promise<ActivityEntry[]>;
  /** booking_id → agent credited with the booking. Missing ids have no recorded source. */
  bookedVia(bookingIds: string[]): Promise<Map<string, string>>;
  /** Forget everything this log holds, booked-via attribution included (a business closing). */
  clear?(): Promise<void>;
}

/** Credit rule: the agent that confirmed wins; otherwise the agent that first held it. */
export function creditsBooking(entry: Omit<ActivityEntry, 'id'>): 'confirm' | 'hold' | null {
  if (!entry.ok || !entry.booking_id) return null;
  return entry.operation === 'confirm' ? 'confirm' : entry.operation === 'hold' ? 'hold' : null;
}

export function toActivityEntry(e: BookingEvent): Omit<ActivityEntry, 'id'> {
  return {
    at: e.at,
    operation: e.operation,
    ok: e.ok,
    ...(e.booking_id ? { booking_id: e.booking_id } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.error_code ? { error_code: e.error_code } : {}),
    ...(e.replayed ? { replayed: true } : {}),
    agent: e.actor?.agent ?? 'Direct API',
    protocol: e.actor?.protocol ?? 'api',
    ...(e.actor?.client ? { client: e.actor.client } : {}),
  };
}

export interface ActivityRecorder {
  detach(): void;
  /** Resolves once every event seen so far is written. */
  idle(): Promise<void>;
}

/**
 * Record every event from `service` into `log` (skips the Studio's own read-only calls). Writes
 * run in the background in event order; failures go to `onError` and never affect bookings.
 */
export function recordActivity(
  service: BookingService,
  log: ActivityLog,
  onError: (error: unknown) => void = (error) =>
    console.error('[openbooking] activity write failed', error),
): ActivityRecorder {
  let tail: Promise<void> = Promise.resolve();
  const detach = service.on((e) => {
    if (e.actor?.protocol === 'studio' && ['list', 'get', 'search'].includes(e.operation)) return;
    const entry = toActivityEntry(e);
    tail = tail.then(() => log.add(entry).then(() => undefined, onError));
  });
  return { detach, idle: () => tail };
}

/**
 * In-memory ring buffer: the most recent N entries per process. Fine for a demo or a single
 * process; use the Postgres activity log to keep history across restarts and instances.
 */
export class ActivityStore implements ActivityLog {
  readonly #entries: ActivityEntry[] = [];
  readonly #limit: number;
  readonly #bookedVia = new Map<string, string>();
  #seq = 0;

  constructor(limit = 2000) {
    this.#limit = limit;
  }

  async add(e: Omit<ActivityEntry, 'id'>): Promise<ActivityEntry> {
    const entry: ActivityEntry = { id: ++this.#seq, ...e };
    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) this.#entries.shift();
    const credit = creditsBooking(e);
    if (credit && (credit === 'confirm' || !this.#bookedVia.has(e.booking_id!))) {
      this.#bookedVia.set(e.booking_id!, e.agent);
    }
    return entry;
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEntry[]> {
    return this.#entries
      .filter(
        (e) =>
          (query.after === undefined || e.id > query.after) &&
          (query.booking_id === undefined || e.booking_id === query.booking_id),
      )
      .reverse()
      .slice(0, query.limit ?? 200);
  }

  async bookedVia(bookingIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of bookingIds) {
      const via = this.#bookedVia.get(id);
      if (via) out.set(id, via);
    }
    return out;
  }

  async clear(): Promise<void> {
    this.#entries.length = 0;
    this.#bookedVia.clear();
  }
}
