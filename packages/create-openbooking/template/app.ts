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
    ...(stores
      ? { serviceOptions: { idempotencyStore: stores.idempotency, guests: stores.guests } }
      : {}),
    // Without a token Studio answers only your own machine (local development). On a host it
    // stays locked until STUDIO_TOKEN is set, also when BASE_URL is missing.
    studio: {
      ...(env.STUDIO_TOKEN ? { token: env.STUDIO_TOKEN } : {}),
      ...(stores ? { activity: stores.activity } : {}),
    },
  });
}
