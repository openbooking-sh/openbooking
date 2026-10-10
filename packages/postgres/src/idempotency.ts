import type { IdempotencyRecord, IdempotencyStore } from '@openbooking-sh/core';
import { json, type Queryable } from './db';

export interface PostgresIdempotencyStoreOptions {
  /** Clock in ms (inject the engine's clock in tests). */
  now?: () => number;
  /** Delete expired records on roughly one in this many writes. Default 200; 0 disables. */
  purgeEvery?: number;
}

/**
 * Idempotency records in Postgres, so a retried tool call replays its first result even when it
 * lands on another server instance or after a restart.
 *
 * Concurrent first-time calls with the same key are still joined per process only (the engine's
 * in-flight map). Across instances they can both run; inventory stays safe because holds are
 * reserved atomically, and the later record wins.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly #db: Queryable;
  readonly #now: () => number;
  readonly #purgeEvery: number;
  #writes = 0;

  constructor(db: Queryable, options: PostgresIdempotencyStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#purgeEvery = options.purgeEvery ?? 200;
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const { rows } = await this.#db.query<{
      fingerprint: string;
      value: unknown;
      created_at: Date;
    }>(
      `select fingerprint, value, created_at from ob_idempotency
        where key = $1 and expires_at > $2::timestamptz`,
      [key, new Date(this.#now()).toISOString()],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      fingerprint: row.fingerprint,
      value: row.value ?? undefined,
      created_at: new Date(row.created_at).getTime(),
    };
  }

  async set(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    await this.#db.query(
      `insert into ob_idempotency (key, fingerprint, value, created_at, expires_at)
       values ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
       on conflict (key) do update
         set fingerprint = excluded.fingerprint, value = excluded.value,
             created_at = excluded.created_at, expires_at = excluded.expires_at`,
      [
        key,
        record.fingerprint,
        json(record.value),
        new Date(record.created_at).toISOString(),
        new Date(this.#now() + ttlMs).toISOString(),
      ],
    );
    if (this.#purgeEvery > 0 && ++this.#writes % this.#purgeEvery === 0) {
      await this.purgeExpired().catch(() => undefined);
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    // left() and char_length() instead of LIKE, so a prefix never needs escaping.
    const { rows } = await this.#db.query(
      'delete from ob_idempotency where left(key, char_length($1::text)) = $1::text returning key',
      [prefix],
    );
    return rows.length;
  }

  /** Delete expired records. Returns how many were removed. */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.#db.query(
      'delete from ob_idempotency where expires_at <= $1::timestamptz returning key',
      [new Date(this.#now()).toISOString()],
    );
    return rows.length;
  }
}
