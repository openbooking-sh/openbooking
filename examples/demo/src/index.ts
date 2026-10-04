/**
 * Demo: "Studio Nord" hair salon (default) or "Demo Bistro Oslo" (DEMO=restaurant), in-memory,
 * bookable by AI agents over MCP, UCP and A2A.
 *
 *   pnpm dev            # from the repo root
 *
 * Env: PORT (default 3000), HOST (default 127.0.0.1), BASE_URL (default http://localhost:PORT),
 *      HOLD_TTL_SECONDS (default 600), STUDIO_TOKEN (required unless BASE_URL is localhost),
 *      DEMO=salon|restaurant (default salon).
 *
 * Keep bookings across restarts with Postgres (tables are created on start):
 *   DATABASE_URL=postgres://user:pass@localhost:5432/openbooking pnpm dev
 *
 * Connect a real Cal.com (or Cal.diy) account instead of the demo data:
 *   CAL_API_KEY=cal_live_... VENUE_NAME="Studio Nord" VENUE_TIMEZONE=Europe/Oslo pnpm dev
 *   Optional: CAL_BASE_URL (Cal.diy), CAL_EVENT_TYPE_IDS="123,456", VENUE_CURRENCY=NOK
 */
import { CalcomBookingProvider } from '@openbooking/provider-calcom';
import {
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking/provider-memory';
import { connectPostgres, migrate, postgresStores } from '@openbooking/postgres';
import { createOpenBookingApp, listen } from '@openbooking/server';

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '127.0.0.1';
const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
const env = process.env;
const demo = env.CAL_API_KEY ? 'calcom' : env.DEMO === 'restaurant' ? 'restaurant' : 'salon';

const db = env.DATABASE_URL ? connectPostgres(env.DATABASE_URL) : undefined;
if (db) await migrate(db);
const stores = db ? postgresStores(db) : undefined;
const store = stores ? { store: stores.bookings } : {};

const provider =
  demo === 'calcom'
    ? new CalcomBookingProvider({
        apiKey: env.CAL_API_KEY!,
        ...(env.CAL_BASE_URL ? { baseUrl: env.CAL_BASE_URL } : {}),
        ...(env.CAL_EVENT_TYPE_IDS
          ? { eventTypeIds: env.CAL_EVENT_TYPE_IDS.split(',').map((x) => Number(x.trim())) }
          : {}),
        ...(stores ? { store: stores.calcom } : {}),
        venue: {
          id: 'venue',
          name: env.VENUE_NAME ?? 'My business',
          timezone: env.VENUE_TIMEZONE ?? 'Europe/Oslo',
          ...(env.VENUE_CURRENCY ? { currency: env.VENUE_CURRENCY } : {}),
        },
      })
    : demo === 'restaurant'
      ? createDemoRestaurantProvider(store)
      : createDemoSalonProvider(store);

const { app, close } = createOpenBookingApp({
  provider,
  baseUrl,
  studio: {
    ...(env.STUDIO_TOKEN ? { token: env.STUDIO_TOKEN } : {}),
    ...(stores ? { activity: stores.activity } : {}),
  },
  serviceOptions: {
    ...(stores ? { idempotencyStore: stores.idempotency } : {}),
    holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 600),
    onEvent: (e) => {
      const what = e.ok
        ? `${e.status ?? 'ok'}${e.replayed ? ' (idempotent replay)' : ''}`
        : `error ${e.error_code}`;
      console.log(
        `[booking] ${e.at} ${(e.actor?.agent ?? 'api').padEnd(10)} ${e.operation.padEnd(7)} ${e.booking_id ?? ''} ${what}`,
      );
    },
  },
});

const server = await listen(app, { port, hostname });

console.log(`
  OpenBooking: ${demo === 'calcom' ? provider.info.name + ' (Cal.com)' : demo === 'restaurant' ? 'Demo Bistro Oslo (restaurant demo)' : 'Studio Nord (hair salon demo)'}

  MCP (Streamable HTTP)  ${baseUrl}/mcp
  UCP profile            ${baseUrl}/.well-known/ucp
  UCP REST               ${baseUrl}/ucp/booking-sessions
  A2A Agent Card         ${baseUrl}/.well-known/agent-card.json

  Studio (dashboard)     ${baseUrl}/studio
  Storage                ${db ? 'Postgres (DATABASE_URL)' : 'in memory (resets on restart)'}

  Try:
    npx @modelcontextprotocol/inspector   (connect to ${baseUrl}/mcp)
    curl "${baseUrl}/ucp/availability?date=$(date -d tomorrow +%F 2>/dev/null || date -v+1d +%F)&party_size=2"
`);

const shutdown = async () => {
  await close();
  await server.close();
  await db?.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
