import type { IdempotencyRecord, IdempotencyStore } from '@openbooking-sh/core';
import { json, type Queryable } from './db';

export interface PostgresIdempotencyStoreOptions {
  /** Clock in ms (inject the engine's clock in tests). */
  now?: () => number;
  /** Delete expired records on roughly one in this many writes. Default 200; 0 disables. */
  purgeEvery?: number;
}

/** Marks a row as a claim, not a result. Recorded results have the form `operation:request`. */
const CLAIM_FINGERPRINT = 'claim';

/**
 * Idempotency records in Postgres, so a retried tool call replays its first result even when it
 * lands on another server instance or after a restart.
 *
 * Concurrent first-time calls with the same key are joined per process by the engine's in-flight
 * map, and across instances by `claim()`: one insert claims the key (a row without a result),
 * the instance that wins runs, and the others wait for its result. A claim that is never
 * finished (a crashed instance) expires, so it cannot block a key for ever. Claim rows carry
 * `CLAIM_FINGERPRINT`, which no recorded result can have (those are `operation:request`), and
 * `get` does not see them.
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
        where key = $1 and fingerprint <> $3 and expires_at > $2::timestamptz`,
      [key, new Date(this.#now()).toISOString(), CLAIM_FINGERPRINT],
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

  async claim(key: string, _fingerprint: string, ttlMs: number): Promise<boolean> {
    const now = new Date(this.#now()).toISOString();
    // One statement, so two instances cannot both win: the insert wins on a free key, and the
    // update only takes over a row that has expired (a dead claim, or an old record).
    const { rows } = await this.#db.query(
      `insert into ob_idempotency (key, fingerprint, value, created_at, expires_at)
       values ($1, $2, null, $3::timestamptz, $4::timestamptz)
       on conflict (key) do update
         set fingerprint = excluded.fingerprint, value = null,
             created_at = excluded.created_at, expires_at = excluded.expires_at
         where ob_idempotency.expires_at <= $3::timestamptz
       returning key`,
      [key, CLAIM_FINGERPRINT, now, new Date(this.#now() + ttlMs).toISOString()],
    );
    return rows.length === 1;
  }

  async release(key: string): Promise<void> {
    // Only a claim: a recorded result is never deleted here.
    await this.#db.query('delete from ob_idempotency where key = $1 and fingerprint = $2', [
      key,
      CLAIM_FINGERPRINT,
    ]);
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
