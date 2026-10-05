/**
 * Vercel Function entry. vercel.json rewrites every path here. OPENBOOKING_MODE=hosted serves
 * hosted OpenBooking (app.openbooking.sh: sign-up, Studio, booking pages, the OpenBooking MCP
 * app); otherwise the single-business demo (salon, or DEMO=restaurant).
 *
 * Storage: set DATABASE_URL (e.g. Neon or Supabase via the Vercel Marketplace; use the pooled
 * connection string) to keep bookings, idempotency records and Studio activity in Postgres.
 * Without it the demo is in-memory: bookings live per function instance and reset on cold starts.
 *
 * Observability (all optional): SENTRY_DSN (errors), POSTHOG_KEY (+ POSTHOG_HOST, EU by default)
 * for product analytics, SLACK_WEBHOOK_URL for operator notifications. Background work (emails,
 * calendar sync, analytics, Slack) finishes after the response via waitUntil.
 */
import * as Sentry from '@sentry/node';
import { waitUntil } from '@vercel/functions';
import {
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking/provider-memory';
import { connectPostgres, migrate, postgresStores } from '@openbooking/postgres';
import {
  PostHogAnalytics,
  SlackNotifier,
  anthropicExtractor,
  createHostedApp,
} from '@openbooking/hosted';
import { ResendMailer } from '@openbooking/notifications';
import { createOpenBookingApp } from '@openbooking/server';

const env = process.env;
const production = env.VERCEL_ENV === 'production';

const host = (v: string | undefined) => (v ? v.replace(/^https?:\/\//, '') : undefined);
const vercelHosts = [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
  .map(host)
  .filter((h): h is string => !!h);

const baseUrl =
  env.BASE_URL ??
  ((vercelHosts[1] ?? vercelHosts[0])
    ? `https://${vercelHosts[1] ?? vercelHosts[0]}`
    : 'http://localhost:3000');

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.VERCEL_ENV ?? 'development',
    // No IPs, cookies or request bodies: bookings contain customer details.
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Failed emails, calendar syncs and analytics are logged with console.error; report those too.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  });
}

interface Runtime {
  fetch(request: Request): Response | Promise<Response>;
  /** Background work started by requests so far. */
  idle(): Promise<void>;
}

async function boot(): Promise<Runtime> {
  const db = env.DATABASE_URL ? connectPostgres(env.DATABASE_URL, { max: 3 }) : undefined;
  if (db) await migrate(db);
  const stores = db ? postgresStores(db) : undefined;
  const store = stores ? { store: stores.bookings } : {};
  const allowedHosts = [
    ...new Set([new URL(baseUrl).hostname, ...vercelHosts, 'localhost', '127.0.0.1']),
  ];

  // OPENBOOKING_MODE=hosted serves many businesses (sign-up, Studio settings, the OpenBooking MCP
  // app). Needs SESSION_SECRET, and DATABASE_URL for anything real: without it accounts and
  // bookings live in memory and vanish on cold starts (see docs/HOSTED.md).
  if (env.OPENBOOKING_MODE === 'hosted') {
    const hosted = createHostedApp({
      baseUrl,
      sessionSecret: env.SESSION_SECRET ?? '',
      // Website import reads services and prices with Claude when ANTHROPIC_API_KEY is set.
      ...(env.ANTHROPIC_API_KEY
        ? { importer: { extractor: anthropicExtractor({ apiKey: env.ANTHROPIC_API_KEY }) } }
        : {}),
      allowedHosts,
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
      ...(env.RESEND_API_KEY
        ? {
            mail: {
              mailer: new ResendMailer({ apiKey: env.RESEND_API_KEY }),
              from: env.MAIL_FROM ?? 'bookings@openbooking.sh',
            },
          }
        : {}),
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.POSTHOG_KEY
        ? {
            analytics: new PostHogAnalytics({
              apiKey: env.POSTHOG_KEY,
              ...(env.POSTHOG_HOST ? { host: env.POSTHOG_HOST } : {}),
            }),
            pageAnalytics: {
              posthogKey: env.POSTHOG_KEY,
              ...(env.POSTHOG_HOST ? { posthogHost: env.POSTHOG_HOST } : {}),
            },
          }
        : {}),
      ...(env.SLACK_WEBHOOK_URL
        ? {
            ops: new SlackNotifier(env.SLACK_WEBHOOK_URL, {
              ...(production ? {} : { prefix: '[preview]' }),
            }),
          }
        : {}),
      ...(env.SENTRY_DSN ? { onError: (e: unknown) => Sentry.captureException(e) } : {}),
    });
    return { fetch: (r) => hosted.app.fetch(r), idle: () => hosted.idle() };
  }

  const single = createOpenBookingApp({
    provider:
      env.DEMO === 'restaurant'
        ? createDemoRestaurantProvider(store)
        : createDemoSalonProvider(store),
    baseUrl,
    // Studio stays locked unless STUDIO_TOKEN is set in the Vercel project env.
    studio: {
      ...(env.STUDIO_TOKEN ? { token: env.STUDIO_TOKEN } : {}),
      ...(stores ? { activity: stores.activity } : {}),
    },
    ...(stores ? { serviceOptions: { idempotencyStore: stores.idempotency } } : {}),
    allowedHosts,
  });
  return {
    fetch: (r) => single.app.fetch(r),
    idle: async () => {
      await single.studio?.idle();
    },
  };
}

// Booted on the first request and reused by the instance; a failed boot is retried next time.
let runtime: Promise<Runtime> | undefined;
const handle = async (request: Request) => {
  runtime ??= boot().catch((error: unknown) => {
    runtime = undefined;
    Sentry.captureException(error);
    throw error;
  });
  const rt = await runtime;
  const response = await rt.fetch(request);
  // Keep the function alive until emails, calendar sync, analytics and Slack posts are sent.
  waitUntil(
    rt
      .idle()
      .then(() => (env.SENTRY_DSN ? Sentry.flush(2000) : true))
      .catch(() => undefined),
  );
  return response;
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
