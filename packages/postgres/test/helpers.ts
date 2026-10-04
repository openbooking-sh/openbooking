/**
 * Test databases. PGlite (embedded Postgres) by default; set TEST_DATABASE_URL to run the same
 * suites against a real server, where each database gets its own schema (dropped afterwards).
 */
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { fromPool, migrate, type Db } from '../src';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const target = TEST_DATABASE_URL ? 'postgres' : 'pglite';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

// Booting PGlite takes a second or two, so migrate one template per file and clone it per test.
let template: Promise<PGlite> | undefined;
const bootTemplate = () =>
  (template ??= (async () => {
    const lite = new PGlite();
    cleanups.push(() => lite.close());
    await migrate(lite);
    return lite;
  })());
// Boot outside the per-test timeout (slow when the whole suite runs in parallel).
beforeAll(async () => {
  if (!TEST_DATABASE_URL) await bootTemplate();
}, 60_000);

/** A migrated, empty database. */
export async function freshDb(): Promise<Db> {
  if (!TEST_DATABASE_URL) {
    const db = await (await bootTemplate()).clone();
    cleanups.push(() => db.close());
    return db;
  }
  const schema = `ob_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: 10,
    options: `-c search_path=${schema}`,
  });
  cleanups.push(async () => {
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });
  const db = fromPool(pool);
  await migrate(db);
  return db;
}
