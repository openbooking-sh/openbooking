/**
 * Hosted OpenBooking locally: sign-up, Studio with settings, one MCP app for every business, a
 * booking page per business. Seeds "Studio Nord" so there is something to book right away.
 *
 *   pnpm dev:hosted     # from the repo root
 *
 * Env: PORT (default 3000), HOST, BASE_URL, SESSION_SECRET (random per run if unset),
 *      RESEND_API_KEY + MAIL_FROM to send real emails (otherwise they're printed here),
 *      GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET for Google Calendar
 *      (redirect URI: {BASE_URL}/oauth/google/callback),
 *      DATABASE_URL to keep accounts, bookings and activity in Postgres (in memory otherwise).
 */
import { createHostedApp, devSecret, hashPassword, starterSettings } from '@openbooking/hosted';
import { ConsoleMailer, ResendMailer } from '@openbooking/notifications';
import { connectPostgres, migrate, postgresStores } from '@openbooking/postgres';
import { listen } from '@openbooking/server';

const env = process.env;
const port = Number(env.PORT ?? 3000);
const baseUrl = env.BASE_URL ?? `http://localhost:${port}`;

const db = env.DATABASE_URL ? connectPostgres(env.DATABASE_URL) : undefined;
if (db) await migrate(db);
const stores = db ? postgresStores(db) : undefined;

const hosted = createHostedApp({
  baseUrl,
  ...(stores
    ? {
        businesses: stores.businesses,
        bookings: stores.bookings,
        idempotency: stores.idempotency,
        activityFor: stores.activityFor,
        calendarLinks: stores.calendarLinks,
        notificationLog: stores.notificationLog,
        rateLimiter: stores.rateLimiter,
      }
    : {}),
  sessionSecret: env.SESSION_SECRET ?? devSecret(),
  mail: {
    mailer: env.RESEND_API_KEY
      ? new ResendMailer({ apiKey: env.RESEND_API_KEY })
      : new ConsoleMailer(),
    from: env.MAIL_FROM ?? 'bookings@openbooking.sh',
  },
  ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
    : {}),
});

// A demo business to log in to and book (created once when the database is new).
const now = new Date().toISOString();
const settings = starterSettings({
  name: 'Studio Nord',
  ownerName: 'Maria',
  category: 'hair_salon',
  city: 'Oslo',
});
settings.profile.address.street_address = 'Eksempelgata 12';
settings.profile.address.postal_code = '0550';
settings.profile.phone_number = '+4700000001';
settings.profile.description = 'Fictional neighbourhood hair salon used for OpenBooking demos.';
settings.staff.push({ id: 'jonas', name: 'Jonas' }, { id: 'aisha', name: 'Aisha' });
if (!(await hosted.businesses.get('studio-nord')))
  await hosted.businesses.create({
    id: 'studio-nord',
    owner: {
      email: 'demo@openbooking.sh',
      password_hash: await hashPassword('openbooking-demo'),
      email_verified_at: now,
    },
    settings,
    created_at: now,
    updated_at: now,
    version: 1,
  });

const server = await listen(hosted.app, { port, hostname: env.HOST ?? '127.0.0.1' });

console.log(`
  OpenBooking (hosted, ${db ? 'Postgres' : 'in memory'})

  Sign up                 ${baseUrl}/signup
  Studio                  ${baseUrl}/studio     demo@openbooking.sh / openbooking-demo
  OpenBooking MCP app     ${baseUrl}/mcp        find_business + booking tools
  Studio Nord             ${baseUrl}/b/studio-nord   (booking page; /mcp, /ucp under it)

  Emails: ${env.RESEND_API_KEY ? 'sent with Resend' : 'printed here (set RESEND_API_KEY to send)'}
  Google Calendar: ${env.GOOGLE_CLIENT_ID ? 'enabled' : 'off (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)'}
`);

const shutdown = async () => {
  await hosted.close();
  await server.close();
  await db?.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
