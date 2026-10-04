import type { CalcomRecord, CalcomStore } from '@openbooking/provider-calcom';
import { json, type Queryable } from './db';

/** Cal.com connector records (holds, OpenBooking ↔ Cal.com ids) in Postgres. */
export class PostgresCalcomStore implements CalcomStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async get(bookingId: string): Promise<CalcomRecord | undefined> {
    const { rows } = await this.#db.query<{ data: CalcomRecord }>(
      'select data from ob_calcom_records where booking_id = $1',
      [bookingId],
    );
    return rows[0]?.data;
  }

  async put(record: CalcomRecord): Promise<void> {
    await this.#db.query(
      `insert into ob_calcom_records (booking_id, data) values ($1, $2::jsonb)
       on conflict (booking_id) do update set data = excluded.data`,
      [record.booking.booking_id, json(record)],
    );
  }

  async list(): Promise<CalcomRecord[]> {
    const { rows } = await this.#db.query<{ data: CalcomRecord }>(
      'select data from ob_calcom_records order by created_at, booking_id',
    );
    return rows.map((r) => r.data);
  }
}
