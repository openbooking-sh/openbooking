/**
 * What `migrate()` costs and guarantees on a serverless cold start: an up-to-date database is
 * recognised with one query (no transaction, no lock), and the locked path still serialises
 * instances that boot at the same time on a fresh database.
 */
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, fromPool, migrate, type Db } from '../src';
import { TEST_DATABASE_URL, freshDb, target } from './helpers';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

/** An empty database, plus a way to open more connections to the same one. */
async function emptyDb(): Promise<{ open: () => Db }> {
  if (!TEST_DATABASE_URL) {
    const lite = new PGlite();
    cleanups.push(() => lite.close());
    return { open: () => lite };
  }
  const schema = `ob_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  return {
    open: () => {
      // One pool per simulated instance, as on Vercel.
      const pool = new pg.Pool({
        connectionString: TEST_DATABASE_URL,
        max: 3,
        options: `-c search_path=${schema}`,
      });
      cleanups.push(() => pool.end());
      return fromPool(pool);
    },
  };
}

/** Record every statement and transaction a Db is asked to run. */
function spy(db: Db) {
  const log = { queries: [] as string[], transactions: 0 };
  const wrapped: Db = {
    query: (text, params) => {
      log.queries.push(text);
      return db.query(text, params);
    },
    transaction: (fn) => {
      log.transactions++;
      return db.transaction(fn);
    },
  };
  return { db: wrapped, log };
}

describe(`migrate on boot (${target})`, { timeout: 60_000 }, () => {
  it('recognises an up-to-date database with one query, no transaction and no lock', async () => {
    const { db, log } = spy(await freshDb()); // already migrated
    expect(await migrate(db)).toEqual([]);
    expect(log.transactions).toBe(0);
    expect(log.queries).toHaveLength(1);
    expect(log.queries[0]).not.toMatch(/advisory/i);
  });

  it('still applies what is pending when only some versions are recorded', async () => {
    const db = await freshDb();
    // A named migration, never "the newest": adding a later one must not change what this proves.
    // Pretend it has not run (forget its record and drop what it made): it must run again, and
    // only it, instead of being skipped by the fast path, although later versions are recorded.
    const missing = MIGRATIONS.find((m) => m.name === 'usp-state')!;
    await db.query('delete from ob_migrations where version = $1', [missing.version]);
    await db.query('drop table ob_usp_owners cascade');
    await db.query('drop table ob_usp_credentials cascade');
    await db.query('drop table ob_usp_proofs cascade');
    await db.query('drop table ob_usp_profile_bindings cascade');
    await db.query('drop table ob_usp_request_keys cascade');
    expect(await migrate(db)).toEqual([missing.version]);
    expect(await migrate(db)).toEqual([]);
  });

  it('reports a connection or permission failure instead of treating it as a fresh database', async () => {
    const down: Db = {
      query: () => Promise.reject(Object.assign(new Error('auth failed'), { code: '28P01' })),
      transaction: () => Promise.reject(new Error('must not start a migration')),
    };
    await expect(migrate(down)).rejects.toThrow('auth failed');
  });

  it('migrates a database that has no migrations table yet', async () => {
    const { open } = await emptyDb();
    expect(await migrate(open())).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('applies every migration exactly once when several instances boot at once', async () => {
    const { open } = await emptyDb();
    const instances = [open(), open(), open()];
    const results = await Promise.all(instances.map((db) => migrate(db)));
    const everything = MIGRATIONS.map((m) => m.version);
    // One instance did the work; the others waited on the lock and found nothing pending.
    expect(results.filter((r) => r.length > 0)).toEqual([everything]);
    expect(results.filter((r) => r.length === 0)).toHaveLength(instances.length - 1);
    const { rows } = await instances[0]!.query<{ version: number }>(
      'select version from ob_migrations order by version',
    );
    expect(rows.map((r) => Number(r.version))).toEqual(everything);
  });
});
