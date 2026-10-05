import pg from 'pg';

/** Anything that runs a parameterised query: a pg Pool/Client, a transaction, or PGlite. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * A database the stores can run transactions on. `pg` pools are wrapped with {@link fromPool};
 * PGlite (embedded Postgres, handy for tests and single-process apps) fits as-is.
 */
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Wrap a `pg` Pool. Each transaction checks out one client and always releases it. */
export function fromPool(pool: pg.Pool): Db {
  return {
    query: (text, params) => pool.query(text, params) as never,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export interface PostgresConnection extends Db {
  pool: pg.Pool;
  end(): Promise<void>;
}

/**
 * Connect to Postgres with a connection string such as `DATABASE_URL`. Keep the pool small on
 * serverless platforms (or point it at a pooler such as PgBouncer / Neon's pooled endpoint).
 */
export function connectPostgres(
  connectionString: string,
  options: Omit<pg.PoolConfig, 'connectionString'> = {},
): PostgresConnection {
  const pool = new pg.Pool({ connectionString: strictSsl(connectionString), max: 5, ...options });
  return { ...fromPool(pool), pool, end: () => pool.end() };
}

/**
 * Hosted Postgres URLs (Neon, Supabase) say `sslmode=require`, which `pg` already treats as
 * `verify-full` but warns about on every start. Say `verify-full` explicitly: same security, no
 * warning, and no silent downgrade when `pg` 9 switches to libpq semantics.
 */
export function strictSsl(connectionString: string): string {
  if (/[?&]uselibpqcompat=/.test(connectionString)) return connectionString;
  return connectionString.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full');
}

/** Serialise a value for a `$n::jsonb` parameter (drivers would turn arrays into PG arrays). */
export const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

/** Lock key for `pg_advisory_xact_lock(hashtextextended($1, 0))`. */
export const LOCK_SQL = 'select pg_advisory_xact_lock(hashtextextended($1, 0))';
