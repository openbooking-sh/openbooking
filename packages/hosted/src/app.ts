import { randomUUID } from 'node:crypto';
import {
  BookingError,
  MemoryIdempotencyStore,
  runAsActor,
  systemClock,
  toErrorPayload,
  type BookingEvent,
  type Clock,
  type IdempotencyStore,
} from '@openbooking/core';
import {
  GoogleAuthError,
  MemoryCalendarLinkStore,
  exchangeCode,
  googleAuthUrl,
  type CalendarLinkStore,
  type GoogleCredentials,
} from '@openbooking/google-calendar';
import {
  MemoryNotificationLog,
  type Mailer,
  type NotificationLog,
} from '@openbooking/notifications';
import { MemoryBookingStore, type BookingRecordStore } from '@openbooking/provider-memory';
import {
  ActivityStore,
  STUDIO_HTML,
  actorFromRequest,
  type ActivityLog,
} from '@openbooking/studio';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import * as z from 'zod';
import {
  OAUTH_STATE_TTL_MS,
  SESSION_TTL_MS,
  createSigner,
  hashPassword,
  verifyPassword,
} from './auth';
import {
  BusinessConflictError,
  MemoryBusinessStore,
  RESERVED_IDS,
  isBookable,
  slugify,
  type Business,
  type BusinessStore,
} from './business';
import { CATEGORIES, starterSettings } from './catalog';
import { createDirectoryServer } from './directory';
import { signupHtml } from './signup';
import { Tenant, type TenantDeps } from './tenant';

export interface HostedOptions {
  /** Public origin, e.g. https://app.openbooking.sh. */
  baseUrl: string;
  /** Signs owner sessions and OAuth state. At least 16 characters; keep it secret and stable. */
  sessionSecret: string;
  businesses?: BusinessStore;
  /** Every business's bookings and holds (venue id = business id). */
  bookings?: BookingRecordStore;
  /** Shared; keys are prefixed per business. */
  idempotency?: IdempotencyStore;
  activityFor?: (businessId: string) => ActivityLog;
  clock?: Clock;
  holdTtlSeconds?: number;
  /** Booking emails. Without it no emails are sent. `from` is a bare address. */
  mail?: { mailer: Mailer; from: string };
  notificationLog?: NotificationLog;
  /** Google OAuth client (Calendar API enabled). The redirect URI is `{baseUrl}/oauth/google/callback`. */
  google?: { clientId: string; clientSecret: string; fetch?: typeof fetch };
  calendarLinks?: CalendarLinkStore;
  /** Host header allow-list for MCP endpoints. Defaults to the baseUrl host plus localhost. */
  allowedHosts?: string[];
  onEvent?: (businessId: string, event: BookingEvent) => void;
  version?: string;
}

export interface HostedApp {
  app: Hono<{ Variables: { tenant: Tenant } }>;
  /** The runtime of one business, or undefined if it doesn't exist. */
  tenant(businessId: string): Promise<Tenant | undefined>;
  businesses: BusinessStore;
  /** Wait for background work (activity, emails, calendar sync) of every loaded business. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

const SignupInput = z.object({
  business_name: z.string().trim().min(1).max(120),
  your_name: z.string().trim().min(1).max(80),
  email: z.email().max(200),
  password: z.string().min(8).max(200),
  category: z.enum(CATEGORIES).default('other'),
  city: z.string().trim().max(100).optional(),
  timezone: z.string().max(60).optional(),
});

const LoginInput = z.object({ email: z.string().max(200), password: z.string().max(200) });

const STUDIO_PATH = '/studio';

/**
 * Hosted OpenBooking: many businesses on one deployment.
 *
 *   GET  /signup                      sign-up page; POST /api/signup, POST /api/login
 *   GET  /studio                      Studio for the logged-in business (bearer session token)
 *   ALL  /mcp                         the OpenBooking app: find_business + booking tools for every listed business
 *   *    /b/{business_id}             that business: booking page (browsers), /mcp, /ucp, /.well-known/*
 *   GET  /oauth/google/callback       Google Calendar connection
 */
export function createHostedApp(options: HostedOptions): HostedApp {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const clock = options.clock ?? systemClock;
  const signer = createSigner(options.sessionSecret, () => clock.now().getTime());
  const businesses = options.businesses ?? new MemoryBusinessStore();
  const activity = new Map<string, ActivityLog>();
  const allowedHosts = options.allowedHosts ?? [
    new URL(baseUrl).hostname,
    'localhost',
    '127.0.0.1',
    '[::1]',
  ];
  const google: (GoogleCredentials & { fetch?: typeof fetch }) | undefined = options.google
    ? { ...options.google, redirectUri: `${baseUrl}/oauth/google/callback` }
    : undefined;

  const deps: TenantDeps = {
    baseUrl,
    businesses,
    bookings: options.bookings ?? new MemoryBookingStore(),
    idempotency: options.idempotency ?? new MemoryIdempotencyStore(() => clock.now().getTime()),
    activityFor:
      options.activityFor ??
      ((id) => {
        if (!activity.has(id)) activity.set(id, new ActivityStore());
        return activity.get(id)!;
      }),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.holdTtlSeconds ? { holdTtlSeconds: options.holdTtlSeconds } : {}),
    ...(options.mail ? { mail: options.mail } : {}),
    notificationLog: options.notificationLog ?? new MemoryNotificationLog(),
    ...(google ? { google } : {}),
    calendarLinks: options.calendarLinks ?? new MemoryCalendarLinkStore(),
    allowedHosts,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };

  // One runtime per business, created on first use. The stored record is re-read on every
  // request so settings saved on another instance apply here too.
  const tenants = new Map<string, Tenant>();
  const tenant = async (id: string): Promise<Tenant | undefined> => {
    const business = await businesses.get(id);
    if (!business) return undefined;
    let t = tenants.get(id);
    if (!t) {
      t = new Tenant(business, deps);
      tenants.set(id, t);
    } else {
      t.sync(business);
    }
    return t;
  };

  const app = new Hono<{ Variables: { tenant: Tenant } }>();
  const err = (c: Context, e: unknown, status: 400 | 401 | 404 | 409 | 500 = 400) =>
    c.json({ error: toErrorPayload(e) }, status);

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/', (c) => {
    if ((c.req.header('accept') ?? '').includes('text/html')) return c.redirect('/signup');
    return c.json({
      name: 'OpenBooking',
      description: 'Book appointments at independent businesses through any AI assistant.',
      mcp: `${baseUrl}/mcp`,
      signup: `${baseUrl}/signup`,
      studio: `${baseUrl}${STUDIO_PATH}`,
    });
  });

  // ---------------------------------------------------------------- Accounts

  app.get('/signup', (c) =>
    c.html(
      signupHtml({ studioPath: STUDIO_PATH, signupApi: '/api/signup', loginPath: STUDIO_PATH }),
    ),
  );

  app.post('/api/signup', async (c) => {
    const parsed = SignupInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return err(c, parsed.error);
    const input = parsed.data;
    if (await businesses.getByEmail(input.email)) {
      return err(
        c,
        new BookingError('validation_error', 'That email already has an account. Log in instead.'),
        409,
      );
    }
    const now = clock.now().toISOString();
    const settings = starterSettings({
      name: input.business_name,
      ownerName: input.your_name,
      category: input.category,
      ...(input.city ? { city: input.city } : {}),
      ...(validTimeZone(input.timezone) ? { timezone: input.timezone } : {}),
    });
    const base = slugify(input.business_name);
    const owner = { email: input.email.trim(), password_hash: await hashPassword(input.password) };
    for (let n = 1; n < 50; n++) {
      const id = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
      if (RESERVED_IDS.has(id)) continue;
      const business: Business = {
        id,
        owner,
        settings,
        created_at: now,
        updated_at: now,
        version: 1,
      };
      try {
        await businesses.create(business);
      } catch (e) {
        if (e instanceof BusinessConflictError && e.field === 'id') continue;
        if (e instanceof BusinessConflictError) {
          return err(c, new BookingError('validation_error', e.message), 409);
        }
        throw e;
      }
      return c.json({
        token: signer.sign('session', id, SESSION_TTL_MS),
        business_id: id,
        studio_url: `${baseUrl}${STUDIO_PATH}`,
        booking_page: `${baseUrl}/b/${id}`,
      });
    }
    return err(c, new BookingError('validation_error', 'Choose a more distinctive business name.'));
  });

  app.post('/api/login', async (c) => {
    const parsed = LoginInput.safeParse(await c.req.json().catch(() => null));
    const business = parsed.success
      ? await businesses.getByEmail(parsed.data.email.trim())
      : undefined;
    const ok =
      business && (await verifyPassword(parsed.data!.password, business.owner.password_hash));
    if (!ok) {
      return c.json({ error: { code: 'unauthorized', message: 'Wrong email or password.' } }, 401);
    }
    return c.json({
      token: signer.sign('session', business.id, SESSION_TTL_MS),
      business_id: business.id,
    });
  });

  // ---------------------------------------------------------------- Studio

  app.get(STUDIO_PATH, (c) => c.html(STUDIO_HTML));
  app.get(`${STUDIO_PATH}/`, (c) => c.redirect(STUDIO_PATH));

  // Every Studio API call: the session token decides which business's Studio answers.
  app.use(`${STUDIO_PATH}/api/*`, async (c, next) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const id = token ? signer.verify('session', token) : undefined;
    const t = id ? await tenant(id) : undefined;
    if (!t) {
      return c.json(
        {
          error: {
            code: 'unauthorized',
            message: 'Log in to continue.',
            login: 'password',
            login_url: '/api/login',
            signup_url: '/signup',
          },
        },
        401,
      );
    }
    c.set('tenant', t);
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.post(`${STUDIO_PATH}/api/integrations/google/connect`, (c) => {
    const t = c.get('tenant');
    if (!google) {
      return err(
        c,
        new BookingError(
          'operation_not_supported',
          'Google Calendar is not set up on this server.',
        ),
      );
    }
    return c.json({
      url: googleAuthUrl(google, {
        state: signer.sign('google', t.id, OAUTH_STATE_TTL_MS),
        loginHint: t.business.owner.email,
      }),
    });
  });

  app.post(`${STUDIO_PATH}/api/integrations/google/disconnect`, async (c) => {
    const t = c.get('tenant');
    const saved = await businesses.update(t.id, ({ google: _, ...rest }) => rest);
    if (saved) t.sync(saved);
    return c.json({ ok: true });
  });

  app.all(`${STUDIO_PATH}/api/*`, (c) => {
    const t = c.get('tenant');
    return forward(t.studio.app, c.req.raw, c.req.path.slice(STUDIO_PATH.length));
  });

  app.get('/oauth/google/callback', async (c) => {
    const back = (result: string) => c.redirect(`${STUDIO_PATH}?google=${result}#settings`);
    const id = signer.verify('google', c.req.query('state') ?? '');
    const code = c.req.query('code');
    if (!google || !id || !code) return back('error');
    try {
      const tokens = await exchangeCode(google, code, {
        ...(google.fetch ? { fetch: google.fetch } : {}),
        now: () => clock.now().getTime(),
      });
      const saved = await businesses.update(id, (b) => ({ ...b, google: { tokens } }));
      if (saved) tenants.get(id)?.sync(saved);
      return back('connected');
    } catch (e) {
      if (!(e instanceof GoogleAuthError)) console.error('[openbooking] Google connect failed', e);
      return back('error');
    }
  });

  // ---------------------------------------------------------------- The OpenBooking app

  const directory = createMcpHandler(() =>
    createDirectoryServer({
      baseUrl,
      ...(options.version ? { version: options.version } : {}),
      listBusinesses: () => businesses.list(),
      service: async (id) => {
        const b = await businesses.get(id);
        const t = b && b.settings.listed && isBookable(b) ? await tenant(id) : undefined;
        if (!t) {
          throw new BookingError('not_found', `No bookable business with business_id "${id}".`, {
            suggested_next_action: 'Call find_business and use a business_id it returns.',
          });
        }
        return t.service;
      },
    }),
  );
  app.use('/mcp', hostHeaderValidation(allowedHosts), originValidation(allowedHosts));
  app.all('/mcp', async (c) =>
    runAsActor(await actorFromRequest(c.req.raw, 'mcp'), () => directory.fetch(c.req.raw)),
  );

  // ---------------------------------------------------------------- One business

  const business = async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const t = await tenant(id);
    if (!t) return c.json({ error: { code: 'not_found', message: `No business "${id}".` } }, 404);
    return forward(t.app, c.req.raw, c.req.path.slice(`/b/${id}`.length));
  };
  app.all('/b/:id', business);
  app.all('/b/:id/*', business);

  return {
    app,
    tenant,
    businesses,
    idle: async () => void (await Promise.all([...tenants.values()].map((t) => t.idle()))),
    close: async () => {
      await Promise.all([...tenants.values()].map((t) => t.close()));
      await directory.close();
    },
  };
}

/** Hand a request to a sub-app with the mount prefix stripped. */
async function forward(
  target: { fetch(request: Request): Response | Promise<Response> },
  req: Request,
  path: string,
): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = path || '/';
  const init: RequestInit = { method: req.method, headers: req.headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
  return target.fetch(new Request(url, init));
}

function validTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A random 32-byte secret, for local development only. */
export function devSecret(): string {
  return randomUUID() + randomUUID();
}
