import { connectPostgres, migrate, postgresStores } from '@openbooking-sh/postgres';
import { MemoryBookingProvider } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp } from '@openbooking-sh/server';
import { business } from './business';

/**
 * The booking backend: booking page, website snippet, MCP for AI assistants, UCP, A2A and Studio.
 * Bookings are kept in memory unless DATABASE_URL points to Postgres.
 */
export async function createApp() {
  const env = process.env;
  const db = env.DATABASE_URL ? connectPostgres(env.DATABASE_URL) : undefined;
  if (db) await migrate(db);
  const stores = db ? postgresStores(db) : undefined;

  const baseUrl =
    env.BASE_URL ??
    (env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : `http://localhost:${env.PORT ?? 3000}`);

  return createOpenBookingApp({
    provider: new MemoryBookingProvider(business, stores ? { store: stores.bookings } : {}),
    baseUrl,
    ...(stores ? { serviceOptions: { idempotencyStore: stores.idempotency } } : {}),
    // Studio is open without a token on localhost only; set STUDIO_TOKEN anywhere else.
    studio: {
      ...(env.STUDIO_TOKEN ? { token: env.STUDIO_TOKEN } : {}),
      ...(stores ? { activity: stores.activity } : {}),
    },
  });
}
