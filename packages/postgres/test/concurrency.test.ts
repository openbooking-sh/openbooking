/**
 * The shared concurrency fuzz suite against the Postgres stores: two engine instances on one
 * database, racing for the same slots. PGlite by default; TEST_DATABASE_URL runs it on a real
 * server (where the transactions truly interleave).
 */
import { PostgresBookingStore, PostgresIdempotencyStore, type Db } from '../src';
import { describeConcurrency, type Backend } from '../../provider-memory/test/concurrency-suite';
import { freshDb, target } from './helpers';

// The suite asks for the booking store, then the idempotency store, for each environment; both
// must share one database.
let db: Db;
const backend: Backend = {
  bookings: async () => {
    db = await freshDb();
    return new PostgresBookingStore(db);
  },
  idempotency: async (now) => new PostgresIdempotencyStore(db, { now }),
};

// Fewer seeds than the memory suite: every seed clones a database.
describeConcurrency(`postgres (${target})`, backend, 2);
