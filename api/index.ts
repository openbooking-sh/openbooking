/**
 * Vercel Function entry: the demo restaurant on one Hono app. vercel.json rewrites every path
 * here, so /mcp, /ucp/*, /.well-known/* and /a2a are all served by this function.
 *
 * Storage: set DATABASE_URL (e.g. Neon or Supabase via the Vercel Marketplace; use the pooled
 * connection string) to keep bookings, idempotency records and Studio activity in Postgres.
 * Without it the demo is in-memory: bookings live per function instance and reset on cold starts.
 */
import {
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking/provider-memory';
import { connectPostgres, migrate, postgresStores } from '@openbooking/postgres';
import { createOpenBookingApp } from '@openbooking/server';

const host = (v: string | undefined) => (v ? v.replace(/^https?:\/\//, '') : undefined);
const vercelHosts = [
  process.env.VERCEL_URL,
  process.env.VERCEL_BRANCH_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
]
  .map(host)
  .filter((h): h is string => !!h);

const baseUrl =
  process.env.BASE_URL ??
  ((vercelHosts[1] ?? vercelHosts[0])
    ? `https://${vercelHosts[1] ?? vercelHosts[0]}`
    : 'http://localhost:3000');

async function boot() {
  const db = process.env.DATABASE_URL
    ? connectPostgres(process.env.DATABASE_URL, { max: 3 })
    : undefined;
  if (db) await migrate(db);
  const stores = db ? postgresStores(db) : undefined;
  const store = stores ? { store: stores.bookings } : {};
  return createOpenBookingApp({
    provider:
      process.env.DEMO === 'restaurant'
        ? createDemoRestaurantProvider(store)
        : createDemoSalonProvider(store),
    baseUrl,
    // Studio stays locked unless STUDIO_TOKEN is set in the Vercel project env.
    studio: {
      ...(process.env.STUDIO_TOKEN ? { token: process.env.STUDIO_TOKEN } : {}),
      ...(stores ? { activity: stores.activity } : {}),
    },
    ...(stores ? { serviceOptions: { idempotencyStore: stores.idempotency } } : {}),
    allowedHosts: [
      ...new Set([new URL(baseUrl).hostname, ...vercelHosts, 'localhost', '127.0.0.1']),
    ],
  }).app;
}

// Booted on the first request and reused by the instance; a failed boot is retried next time.
let app: ReturnType<typeof boot> | undefined;
const handle = async (request: Request) => {
  app ??= boot().catch((error: unknown) => {
    app = undefined;
    throw error;
  });
  return (await app).fetch(request);
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
