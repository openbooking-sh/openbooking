import {
  creditsBooking,
  type ActivityEntry,
  type ActivityLog,
  type ActivityQuery,
} from '@openbooking/studio';
import { json, type Db } from './db';

/** Studio activity and booked-via attribution in Postgres: history survives restarts. */
export class PostgresActivityLog implements ActivityLog {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async add(e: Omit<ActivityEntry, 'id'>): Promise<ActivityEntry> {
    return this.#db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into ob_activity (at, booking_id, agent, entry)
         values ($1::timestamptz, $2, $3, $4::jsonb) returning id::text as id`,
        [e.at, e.booking_id ?? null, e.agent, json(e)],
      );
      const credit = creditsBooking(e);
      if (credit) {
        // The confirming agent wins; a hold only credits a booking nobody has claimed yet.
        await tx.query(
          `insert into ob_booked_via (booking_id, agent, credit) values ($1, $2, $3)
           on conflict (booking_id) do ${
             credit === 'confirm'
               ? 'update set agent = excluded.agent, credit = excluded.credit'
               : 'nothing'
           }`,
          [e.booking_id, e.agent, credit],
        );
      }
      return { id: Number(rows[0]!.id), ...e };
    });
  }

  async list(query: ActivityQuery = {}): Promise<ActivityEntry[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.after !== undefined) {
      params.push(query.after);
      where.push(`id > $${params.length}`);
    }
    if (query.booking_id !== undefined) {
      params.push(query.booking_id);
      where.push(`booking_id = $${params.length}`);
    }
    params.push(query.limit ?? 200);
    const { rows } = await this.#db.query<{ id: string; entry: Omit<ActivityEntry, 'id'> }>(
      `select id::text as id, entry from ob_activity
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by id desc limit $${params.length}`,
      params,
    );
    return rows.map((r) => ({ id: Number(r.id), ...r.entry }));
  }

  async bookedVia(bookingIds: string[]): Promise<Map<string, string>> {
    if (!bookingIds.length) return new Map();
    const { rows } = await this.#db.query<{ booking_id: string; agent: string }>(
      'select booking_id, agent from ob_booked_via where booking_id = any($1::text[])',
      [bookingIds],
    );
    return new Map(rows.map((r) => [r.booking_id, r.agent]));
  }
}
