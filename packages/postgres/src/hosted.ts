/**
 * Stores for hosted OpenBooking: business accounts, Google Calendar links, the email dedupe log
 * and rate limits.
 */
import type { CalendarLink, CalendarLinkStore } from '@openbooking-sh/google-calendar';
import type { Business, BusinessStore, RateLimiter } from '@openbooking-sh/hosted';
import type { NotificationLog } from '@openbooking-sh/notifications';
import { json, type Db, type Queryable } from './db';

/**
 * The hosted package's conflict error, loaded only when needed: `@openbooking-sh/hosted` is an
 * optional peer, so importing it eagerly would break apps that use Postgres without hosting.
 * Everyone who uses PostgresBusinessStore has hosted installed.
 */
async function conflict(field: 'id' | 'email'): Promise<Error> {
  const { BusinessConflictError } = await import('@openbooking-sh/hosted');
  return new BusinessConflictError(field);
}

/** One row per business: the record as JSON, plus unique id and (case-insensitive) owner email. */
export class PostgresBusinessStore implements BusinessStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async create(business: Business): Promise<void> {
    await this.#db.transaction(async (tx) => {
      // Check first for a precise error; the unique indexes still guard concurrent sign-ups.
      const { rows } = await tx.query<{ id: string }>(
        'select id from ob_businesses where id = $1 or owner_email = lower($2)',
        [business.id, business.owner.email],
      );
      if (rows.length) {
        throw await conflict(rows.some((r) => r.id === business.id) ? 'id' : 'email');
      }
      try {
        await tx.query(
          `insert into ob_businesses (id, owner_email, created_at, data)
           values ($1, lower($2), $3::timestamptz, $4::jsonb)`,
          [business.id, business.owner.email, business.created_at, json(business)],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw await conflict(
            String((e as { constraint?: string }).constraint ?? '').includes('email')
              ? 'email'
              : 'id',
          );
        }
        throw e;
      }
    });
  }

  async get(id: string): Promise<Business | undefined> {
    const { rows } = await this.#db.query<{ data: Business }>(
      'select data from ob_businesses where id = $1',
      [id],
    );
    return rows[0]?.data;
  }

  async getByEmail(email: string): Promise<Business | undefined> {
    const { rows } = await this.#db.query<{ data: Business }>(
      'select data from ob_businesses where owner_email = lower($1)',
      [email.trim()],
    );
    return rows[0]?.data;
  }

  async delete(id: string): Promise<boolean> {
    const { rows } = await this.#db.query('delete from ob_businesses where id = $1 returning id', [
      id,
    ]);
    return rows.length > 0;
  }

  async update(id: string, fn: (business: Business) => Business): Promise<Business | undefined> {
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.query<{ data: Business }>(
        'select data from ob_businesses where id = $1 for update',
        [id],
      );
      if (!rows[0]) return undefined;
      const next = fn(rows[0].data);
      try {
        await tx.query(
          'update ob_businesses set owner_email = lower($2), data = $3::jsonb where id = $1',
          [id, next.owner.email, json(next)],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw await conflict('email');
        throw e;
      }
      return next;
    });
  }

  async list(): Promise<Business[]> {
    const { rows } = await this.#db.query<{ data: Business }>(
      'select data from ob_businesses order by created_at, id',
    );
    return rows.map((r) => r.data);
  }
}

/** Booking id → Google Calendar event, so any instance can update or delete the event. */
export class PostgresCalendarLinkStore implements CalendarLinkStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async get(bookingId: string): Promise<CalendarLink | undefined> {
    const { rows } = await this.#db.query<{ calendar_id: string; event_id: string }>(
      'select calendar_id, event_id from ob_calendar_links where booking_id = $1',
      [bookingId],
    );
    return rows[0] ? { calendar_id: rows[0].calendar_id, event_id: rows[0].event_id } : undefined;
  }

  async set(bookingId: string, link: CalendarLink): Promise<void> {
    await this.#db.query(
      `insert into ob_calendar_links (booking_id, calendar_id, event_id) values ($1, $2, $3)
       on conflict (booking_id) do update
         set calendar_id = excluded.calendar_id, event_id = excluded.event_id`,
      [bookingId, link.calendar_id, link.event_id],
    );
  }

  async delete(bookingId: string): Promise<void> {
    await this.#db.query('delete from ob_calendar_links where booking_id = $1', [bookingId]);
  }
}

/** Email dedupe: a key is claimed once across every instance, so no email goes out twice. */
export class PostgresNotificationLog implements NotificationLog {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async claim(key: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      `insert into ob_notification_log (key) values ($1)
       on conflict (key) do nothing returning key`,
      [key],
    );
    return rows.length > 0;
  }
}

/** Fixed-window counters shared by every instance. */
export class PostgresRateLimiter implements RateLimiter {
  readonly #db: Queryable;
  readonly #now: () => number;

  constructor(db: Queryable, options: { now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = this.#now();
    const { rows } = await this.#db.query<{ count: number }>(
      `insert into ob_rate_limits (key, window_start, count) values ($1, $2::timestamptz, 1)
       on conflict (key) do update set
         count = case when ob_rate_limits.window_start <= $3::timestamptz then 1
                      else ob_rate_limits.count + 1 end,
         window_start = case when ob_rate_limits.window_start <= $3::timestamptz
                             then excluded.window_start else ob_rate_limits.window_start end
       returning count`,
      [key, new Date(now).toISOString(), new Date(now - windowMs).toISOString()],
    );
    return Number(rows[0]!.count) <= limit;
  }

  /** Delete windows older than `maxAgeMs` (run occasionally; the table stays small anyway). */
  async purge(maxAgeMs = 24 * 3_600_000): Promise<void> {
    await this.#db.query('delete from ob_rate_limits where window_start < $1::timestamptz', [
      new Date(this.#now() - maxAgeMs).toISOString(),
    ]);
  }
}
