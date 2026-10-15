import { json, type Queryable } from './db';

/** A booking-scoped credential as the USP adapter keeps it: by hash, never the value. */
export interface UspCredentialRecord {
  hash: string;
  expiresAt: Date;
  jkt?: string | undefined;
  scope: readonly string[];
}

export interface PostgresUspStateOptions {
  /** Clock in ms (inject the engine's clock in tests). */
  now?: () => number;
  /**
   * How long an Idempotency-Key remembers its request. The spec asks for at least 24 hours; keep
   * a margin. Default 48 hours.
   */
  requestKeyTtlMs?: number;
  /** Delete expired rows on roughly one in this many writes. Default 200; 0 disables. */
  purgeEvery?: number;
}

/**
 * What the USP adapter (`@openbooking-sh/adapter-usp`) remembers, in Postgres, so a credential
 * issued by one server instance is known to every other and a proof replayed against a second
 * instance is still caught.
 *
 * This class matches the adapter's `UspStateStore` structurally (this package must not depend on
 * the adapter). The adapter's tests check the two stay compatible.
 *
 * Every check-and-record is one statement (`insert … on conflict`), so two instances racing on the
 * same proof or key cannot both win. Run {@link migrate} first.
 */
export class PostgresUspState {
  readonly #db: Queryable;
  readonly #now: () => number;
  readonly #requestKeyTtlMs: number;
  readonly #purgeEvery: number;
  #writes = 0;

  constructor(db: Queryable, options: PostgresUspStateOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#requestKeyTtlMs = options.requestKeyTtlMs ?? 48 * 3600_000;
    this.#purgeEvery = options.purgeEvery ?? 200;
  }

  #at = (ms = 0) => new Date(this.#now() + ms).toISOString();

  /** Record who owns a hold/booking. First claim wins; later claims by another principal fail. */
  async claim(bookingId: string, principal: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      `insert into ob_usp_owners (booking_id, principal, created_at)
       values ($1, $2, $3::timestamptz)
       on conflict (booking_id) do nothing returning booking_id`,
      [bookingId, principal, this.#at()],
    );
    if (rows.length) {
      await this.#maybePurge();
      return true;
    }
    return (await this.ownerOf(bookingId)) === principal;
  }

  async ownerOf(bookingId: string): Promise<string | undefined> {
    const { rows } = await this.#db.query<{ principal: string }>(
      'select principal from ob_usp_owners where booking_id = $1',
      [bookingId],
    );
    return rows[0]?.principal;
  }

  async markBooking(bookingId: string): Promise<void> {
    await this.#db.query('update ob_usp_owners set is_booking = true where booking_id = $1', [
      bookingId,
    ]);
  }

  async isBooking(bookingId: string): Promise<boolean> {
    const { rows } = await this.#db.query<{ is_booking: boolean }>(
      'select is_booking from ob_usp_owners where booking_id = $1',
      [bookingId],
    );
    return rows[0]?.is_booking === true;
  }

  /**
   * Remember what request an Idempotency-Key was first used for. True for a new key or the same
   * request again; false when the key is reused for a different request. A key past its time to
   * live counts as new.
   */
  async checkKey(scopedKey: string, fingerprint: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      `insert into ob_usp_request_keys (scoped_key, fingerprint, expires_at)
       values ($1, $2, $3::timestamptz)
       on conflict (scoped_key) do update
         set fingerprint = excluded.fingerprint, expires_at = excluded.expires_at
         where ob_usp_request_keys.expires_at <= $4::timestamptz
       returning scoped_key`,
      [scopedKey, fingerprint, this.#at(this.#requestKeyTtlMs), this.#at()],
    );
    if (rows.length) {
      await this.#maybePurge();
      return true;
    }
    const existing = await this.#db.query<{ fingerprint: string }>(
      'select fingerprint from ob_usp_request_keys where scoped_key = $1',
      [scopedKey],
    );
    return existing.rows[0]?.fingerprint === fingerprint;
  }

  async saveCredential(credential: UspCredentialRecord): Promise<void> {
    await this.#db.query(
      `insert into ob_usp_credentials (hash, jkt, scope, expires_at)
       values ($1, $2, $3::jsonb, $4::timestamptz)
       on conflict (hash) do nothing`,
      [
        credential.hash,
        credential.jkt ?? null,
        json([...credential.scope]),
        credential.expiresAt.toISOString(),
      ],
    );
    await this.#maybePurge();
  }

  /** The credential with this hash, expired or not: the verifier judges expiry itself. */
  async findCredential(hash: string): Promise<UspCredentialRecord | undefined> {
    const { rows } = await this.#db.query<{
      hash: string;
      jkt: string | null;
      scope: string[];
      expires_at: Date;
    }>('select hash, jkt, scope, expires_at from ob_usp_credentials where hash = $1', [hash]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      hash: row.hash,
      expiresAt: new Date(row.expires_at),
      ...(row.jkt ? { jkt: row.jkt } : {}),
      scope: row.scope,
    };
  }

  /** True if this proof `jti` was already seen (and is still remembered); records it otherwise. */
  async seenJti(jti: string, ttlMs: number): Promise<boolean> {
    const { rows } = await this.#db.query(
      `insert into ob_usp_proofs (jti, expires_at) values ($1, $2::timestamptz)
       on conflict (jti) do update set expires_at = excluded.expires_at
         where ob_usp_proofs.expires_at <= $3::timestamptz
       returning jti`,
      [jti, this.#at(ttlMs), this.#at()],
    );
    if (rows.length) {
      await this.#maybePurge();
      return false;
    }
    return true;
  }

  /**
   * Trust on first use: tie a platform key to the profile URI it first presented. True for a new
   * key or the same profile again; false when that key shows up with a different profile.
   */
  async bindProfile(jkt: string, profileUri: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      `insert into ob_usp_profile_bindings (jkt, profile_uri, created_at)
       values ($1, $2, $3::timestamptz)
       on conflict (jkt) do nothing returning jkt`,
      [jkt, profileUri, this.#at()],
    );
    if (rows.length) return true;
    const existing = await this.#db.query<{ profile_uri: string }>(
      'select profile_uri from ob_usp_profile_bindings where jkt = $1',
      [jkt],
    );
    return existing.rows[0]?.profile_uri === profileUri;
  }

  /** Delete expired proofs, request keys and credentials. Returns how many rows were removed. */
  async purgeExpired(): Promise<number> {
    const now = this.#at();
    let removed = 0;
    for (const table of ['ob_usp_proofs', 'ob_usp_request_keys', 'ob_usp_credentials']) {
      const { rows } = await this.#db.query(
        `delete from ${table} where expires_at <= $1::timestamptz returning 1`,
        [now],
      );
      removed += rows.length;
    }
    return removed;
  }

  async #maybePurge(): Promise<void> {
    if (this.#purgeEvery > 0 && ++this.#writes % this.#purgeEvery === 0) {
      await this.purgeExpired().catch(() => undefined);
    }
  }
}
