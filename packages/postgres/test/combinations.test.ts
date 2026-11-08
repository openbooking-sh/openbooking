/**
 * Joined tables on the Postgres store: the shared suite from provider-memory, with the engine on
 * top, then races made certain rather than left to timing. PGlite by default; TEST_DATABASE_URL
 * runs it on a real server, where the transactions truly interleave.
 */
import { describe, expect, it } from 'vitest';
import { PostgresBookingStore, type Db, type Queryable } from '../src';
import { describeTableCombinations } from '../../provider-memory/test/combination-suite';
import { record } from '../../provider-memory/test/store-contract';
import { freshDb, target } from './helpers';

// Fewer seeds than the memory run: every case clones a database.
describeTableCombinations(
  `postgres (${target})`,
  async () => new PostgresBookingStore(await freshDb()),
  4,
);

/**
 * A database whose transactions all stop right after reading "is anything overlapping?", until
 * `parties` of them have read it (or a moment has passed). That makes every writer read before any
 * of them writes, which is what only the per-table locks can prevent: if they let two writers
 * through together, both see "free". Correct locking makes the second writer wait for the first,
 * so the gate times out for the first and the test still passes, just a little slower.
 */
function readThenGate(db: Db, parties: number, waitMs = 400): Db {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const gateTx = (tx: Queryable): Queryable => ({
    query: (async (text: string, params?: unknown[]) => {
      const out = await tx.query(text, params);
      if (/^\s*select 1 from ob_bookings/.test(text)) {
        if (++arrived >= parties) open();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([gate, new Promise((r) => (timer = setTimeout(r, waitMs)))]);
        clearTimeout(timer);
      }
      return out;
    }) as Queryable['query'],
  });
  return {
    query: ((text: string, params?: unknown[]) => db.query(text, params)) as Db['query'],
    transaction: (fn) => db.transaction((tx) => fn(gateTx(tx))),
  };
}

const T0 = Date.parse('2030-06-01T10:00:00Z');
const NOW = new Date(T0 - 5 * 60_000);

describe(`joined tables, forced races (${target})`, () => {
  it('two bookings that share only a second table cannot both be inserted', async () => {
    // Their primary tables differ (p1, p3): only the joined table p2 is shared.
    const store = new PostgresBookingStore(readThenGate(await freshDb(), 2));
    const results = await Promise.all([
      store.insertIfFree(record({ id: 'one', resource: 'p1', extra: ['p2'] }), NOW),
      store.insertIfFree(record({ id: 'two', resource: 'p3', extra: ['p2'] }), NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a late confirm of joined tables cannot take a table that was re-booked after the hold lapsed', async () => {
    const db = await freshDb();
    const plain = new PostgresBookingStore(db);
    // A hold of p1+p2 that lapses at T0 - 2 min.
    await plain.insertIfFree(
      record({ id: 'late', resource: 'p1', extra: ['p2'], expires: T0 - 2 * 60_000 }),
      NOW,
    );
    const store = new PostgresBookingStore(readThenGate(db, 2));
    const afterExpiry = new Date(T0 - 60_000);
    const beforeExpiry = new Date(T0 - 3 * 60_000); // a lagging clock still sees the hold alive
    const [confirm, rebook] = await Promise.allSettled([
      store.update('late', beforeExpiry, (b) => ({ ...b, status: 'confirmed', expires_at: null })),
      // Someone else takes p2 (the joined table, not the primary one) once the hold has lapsed.
      store.insertIfFree(record({ id: 'new', resource: 'p2' }), afterExpiry),
    ]);
    const confirmed = confirm.status === 'fulfilled';
    const rebooked = rebook.status === 'fulfilled' && rebook.value;
    expect(confirmed && rebooked, 'both won the same table').toBe(false);
  });

  it('two moves into overlapping joined tables cannot both succeed', async () => {
    const db = await freshDb();
    const plain = new PostgresBookingStore(db);
    for (const [id, resource] of [
      ['m1', 'a1'],
      ['m2', 'a2'],
    ] as const) {
      await plain.insertIfFree(record({ id, resource, status: 'confirmed', expires: null }), NOW);
    }
    const store = new PostgresBookingStore(readThenGate(db, 2));
    const target = T0 + 300 * 60_000;
    const move = (id: string, resource: string) =>
      store.move(
        record({
          id,
          resource,
          extra: ['shared'],
          start: target,
          status: 'confirmed',
          expires: null,
        }),
        NOW,
        () => {},
      );
    const results = await Promise.all([move('m1', 'b1'), move('m2', 'b2')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
