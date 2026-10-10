import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BookingError,
  MemoryIdempotencyStore,
  runAsActor,
  systemClock,
  toErrorPayload,
  type BookingEvent,
  type Clock,
  type IdempotencyStore,
} from '@openbooking-sh/core';
import {
  GoogleAuthError,
  MemoryCalendarLinkStore,
  exchangeCode,
  googleAuthUrl,
  type CalendarLinkStore,
  type GoogleCredentials,
} from '@openbooking-sh/google-calendar';
import {
  MemoryNotificationLog,
  type Mailer,
  type NotificationLog,
} from '@openbooking-sh/notifications';
import { MemoryBookingStore, type BookingRecordStore } from '@openbooking-sh/provider-memory';
import {
  ActivityStore,
  STUDIO_HTML,
  actorFromRequest,
  type ActivityLog,
} from '@openbooking-sh/studio';
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
  isListable,
  slugify,
  type Business,
  type BusinessStore,
} from './business';
import { CATEGORIES, starterSettings } from './catalog';
import { createDirectoryServer } from './directory';
import {
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  passwordTag,
  resetEmail,
  resetHtml,
  verifyEmail,
} from './account';
import { LIMITS, MemoryRateLimiter, proxyClientIp, type RateLimiter } from './limits';
import { ImportError, importFromWebsite, type ImportOptions } from './importer';
import { setupHtml } from './setup';
import { posthogSnippet, withHeadSnippet, type Analytics } from './analytics';
import { slackEscape, type OpsNotifier } from './slack';
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
  /**
   * Days after a booking ends before the customer's name, contact details and notes are removed
   * from it (the booking itself stays). Default 730. 0 turns the clean-up off.
   */
  retentionDays?: number;
  /**
   * Secret for `GET /api/maintenance/purge`, which applies the retention period. Vercel Cron
   * sends it as `Authorization: Bearer $CRON_SECRET`. The endpoint does not exist without it.
   */
  cronSecret?: string;
  holdTtlSeconds?: number;
  /** Booking emails. Without it no emails are sent. `from` is a bare address. */
  mail?: { mailer: Mailer; from: string };
  notificationLog?: NotificationLog;
  /** Google OAuth client (Calendar API enabled). The redirect URI is `{baseUrl}/oauth/google/callback`. */
  google?: { clientId: string; clientSecret: string; fetch?: typeof fetch };
  calendarLinks?: CalendarLinkStore;
  /** Host header allow-list for MCP endpoints. Defaults to the baseUrl host plus localhost. */
  allowedHosts?: string[];
  /** Limits for login, sign-up and password reset. Memory by default; Postgres across instances. */
  rateLimiter?: RateLimiter;
  /** The caller's IP for rate limits. Defaults to proxy headers (x-real-ip, x-forwarded-for). */
  clientIp?: (request: Request) => string;
  /**
   * List a business in the OpenBooking app only after the owner confirmed their email. Defaults
   * to true when `mail` is set (otherwise there is no way to confirm).
   */
  requireVerifiedEmail?: boolean;
  /**
   * "Import from your website" during setup. Pass an `extractor` (e.g. `anthropicExtractor`) to
   * also read services and prices with an LLM; without it only structured data and page basics are
   * used. `fetch`/`lookup` are for tests.
   */
  importer?: Pick<ImportOptions, 'extractor' | 'fetch' | 'lookup'>;
  onEvent?: (businessId: string, event: BookingEvent) => void;
  /** Product analytics (e.g. PostHogAnalytics). Events carry business ids only, never personal data. */
  analytics?: Analytics;
  /** PostHog browser snippet on owner pages (sign-up, setup, reset, Studio). Never on booking pages. */
  pageAnalytics?: { posthogKey: string; posthogHost?: string };
  /** Called with unexpected errors (e.g. Sentry.captureException). The request still gets a 500. */
  onError?: (error: unknown) => void;
  /**
   * Operator notifications (e.g. SlackNotifier): sign-ups, email confirmations, bookings,
   * cancellations, Google connections and server errors. Business names only, no customer data.
   */
  ops?: OpsNotifier;
  version?: string;
}

export interface HostedApp {
  app: Hono<{ Variables: { tenant: Tenant } }>;
  /** The runtime of one business, or undefined if it doesn't exist. */
  tenant(businessId: string): Promise<Tenant | undefined>;
  businesses: BusinessStore;
  /** Wait for background work (activity, emails, calendar sync) of every loaded business. */
  idle(): Promise<void>;
  /** Remove personal data from bookings past the retention period. Safe to run any time. */
  purgeExpiredData(): Promise<{ businesses: number; anonymized: number }>;
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
  /** Where the sign-up came from, e.g. "hero" (website button), a utm_source or a referring site. */
  source: z
    .string()
    .trim()
    .max(80)
    .regex(/^[\w.:/-]*$/)
    .optional()
    .catch(undefined),
});

const DeleteAccountInput = z.object({ password: z.string().max(200) });
const LoginInput = z.object({ email: z.string().max(200), password: z.string().max(200) });
const ForgotInput = z.object({ email: z.string().max(200) });
const ResetInput = z.object({ token: z.string().max(500), password: z.string().min(8).max(200) });

const STUDIO_PATH = '/studio';

/**
 * Hosted OpenBooking: many businesses on one deployment.
 *
 *   GET  /signup                      sign-up page; POST /api/signup, POST /api/login
 *   GET  /reset                       password reset; POST /api/password/forgot, /api/password/reset
 *   GET  /api/verify-email?token=     confirms the owner's email (link from the welcome email)
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
  const limiter: RateLimiter =
    options.rateLimiter ?? new MemoryRateLimiter(() => clock.now().getTime());
  const clientIp = options.clientIp ?? proxyClientIp;
  const requireVerifiedEmail = options.requireVerifiedEmail ?? !!options.mail;
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
    requireVerifiedEmail,
    ...(options.onEvent || options.analytics || options.ops
      ? {
          onEvent: (businessId: string, e: BookingEvent) => {
            options.onEvent?.(businessId, e);
            if (!e.ok || e.replayed) return;
            const channel = e.actor?.agent ?? 'Direct API';
            const event = BOOKING_EVENTS[e.operation];
            if (event) {
              options.analytics?.capture(event, businessId, {
                channel,
                protocol: e.actor?.protocol ?? 'api',
              });
            }
            if (options.ops && (e.operation === 'confirm' || e.operation === 'cancel')) {
              const name = slackEscape(
                tenants.get(businessId)?.business.settings.profile.name ?? businessId,
              );
              options.ops.notify(
                e.operation === 'confirm'
                  ? `:calendar: *${name}* got a booking via ${slackEscape(channel)}`
                  : `:x: A booking at *${name}* was cancelled (via ${slackEscape(channel)})`,
              );
            }
          },
        }
      : {}),
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
  const err = (c: Context, e: unknown, status: 400 | 401 | 404 | 409 | 500 | 501 = 400) =>
    c.json({ error: toErrorPayload(e) }, status);

  const tooMany = (c: Context) =>
    c.json(
      {
        error: {
          code: 'rate_limited',
          message: 'Too many attempts. Wait a few minutes and try again.',
        },
      },
      429,
    );
  /** False when any of the limits is exceeded (every limit is still counted). */
  const allowed = async (...hits: Array<[string, { limit: number; windowMs: number }]>) => {
    const results = await Promise.all(
      hits.map(([key, l]) => limiter.hit(key, l.limit, l.windowMs)),
    );
    return results.every(Boolean);
  };

  // Session tokens carry the owner's session epoch; a password reset bumps it.
  const sessionToken = (b: Business) =>
    signer.sign('session', `${b.id}.${b.owner.session_epoch ?? 0}`, SESSION_TTL_MS);
  const sessionBusiness = async (token: string): Promise<Tenant | undefined> => {
    const subject = token ? signer.verify('session', token) : undefined;
    if (!subject) return undefined;
    const dot = subject.lastIndexOf('.');
    // Tokens issued before epochs existed carry just the id (epoch 0).
    const [id, epoch] =
      dot === -1 ? [subject, 0] : [subject.slice(0, dot), Number(subject.slice(dot + 1))];
    const t = await tenant(id);
    return t && (t.business.owner.session_epoch ?? 0) === epoch ? t : undefined;
  };

  const sendVerification = async (b: Business) => {
    if (!options.mail || b.owner.email_verified_at) return;
    const token = signer.sign(
      'verify-email',
      `${b.id}:${b.owner.email.toLowerCase()}`,
      VERIFY_TTL_MS,
    );
    const url = `${baseUrl}/api/verify-email?token=${encodeURIComponent(token)}`;
    await options.mail.mailer.send(
      verifyEmail(b.owner.email, options.mail.from, url, b.settings.profile.name),
    );
  };

  // Work that outlives a response (account emails). idle() waits for it, so serverless hosts can
  // keep the function alive until it is done (Vercel: waitUntil(hosted.idle())).
  const background = new Set<Promise<unknown>>();
  const later = (p: Promise<unknown>, what: string) => {
    const tracked = p.catch((e: unknown) => console.error(`[openbooking] ${what} failed`, e));
    background.add(tracked);
    void tracked.finally(() => background.delete(tracked));
  };
  const track = (event: string, businessId: string, props?: Record<string, unknown>) =>
    options.analytics?.capture(event, businessId, props);
  const snippet = options.pageAnalytics
    ? posthogSnippet(options.pageAnalytics.posthogKey, options.pageAnalytics.posthogHost)
    : undefined;
  const page = (html: string) => withHeadSnippet(html, snippet);

  // Server errors go to Slack too, at most one message a minute so an outage can't flood it.
  let lastErrorPing = 0;
  const opsLink = (id: string, label: string) => `<${baseUrl}/b/${id}|${label}>`;
  const businessName = (b: Business) => slackEscape(b.settings.profile.name);

  app.onError((e, c) => {
    console.error('[openbooking] request failed', e);
    options.onError?.(e);
    const now = clock.now().getTime();
    if (options.ops && now - lastErrorPing > 60_000) {
      lastErrorPing = now;
      const msg = e instanceof Error ? e.message : String(e);
      options.ops.notify(
        `:warning: Server error on ${c.req.method} ${new URL(c.req.url).pathname}: ${slackEscape(msg.slice(0, 300))}`,
      );
    }
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Search engines and AI crawlers find each listed business's booking page through the sitemap;
  // owner pages (Studio, setup, the API) aren't for indexing.
  app.get('/robots.txt', (c) =>
    c.text(
      [
        'User-agent: *',
        'Allow: /',
        `Disallow: ${STUDIO_PATH}`,
        'Disallow: /setup',
        'Disallow: /api/',
        `Sitemap: ${baseUrl}/sitemap.xml`,
        '',
      ].join('\n'),
    ),
  );
  app.get('/sitemap.xml', async (c) => {
    const listed = (await businesses.list()).filter((b) => isListable(b, requireVerifiedEmail));
    const urls = listed.map(
      (b) =>
        `  <url><loc>${baseUrl}/b/${encodeURIComponent(b.id)}</loc><lastmod>${b.updated_at.slice(0, 10)}</lastmod></url>`,
    );
    c.header('content-type', 'application/xml; charset=utf-8');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    );
  });

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
      page(
        signupHtml({
          studioPath: STUDIO_PATH,
          setupPath: '/setup',
          signupApi: '/api/signup',
          loginPath: STUDIO_PATH,
        }),
      ),
    ),
  );

  app.post('/api/signup', async (c) => {
    if (!(await allowed([`signup:ip:${clientIp(c.req.raw)}`, LIMITS.signupPerIp])))
      return tooMany(c);
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
      later(sendVerification(business), 'verification email');
      track('business_signed_up', id, {
        category: input.category,
        city: input.city ?? null,
        source: input.source ?? null,
      });
      options.ops?.notify(
        `:tada: New business: *${businessName(business)}* (${input.category.replace(/_/g, ' ')}${input.city ? `, ${slackEscape(input.city)}` : ''})${input.source ? ` · via ${slackEscape(input.source)}` : ''} · ${opsLink(id, 'booking page')}`,
      );
      return c.json({
        token: sessionToken(business),
        business_id: id,
        studio_url: `${baseUrl}${STUDIO_PATH}`,
        booking_page: `${baseUrl}/b/${id}`,
      });
    }
    return err(c, new BookingError('validation_error', 'Choose a more distinctive business name.'));
  });

  app.post('/api/login', async (c) => {
    const parsed = LoginInput.safeParse(await c.req.json().catch(() => null));
    const email = parsed.success ? parsed.data.email.trim().toLowerCase() : '';
    const permitted = await allowed(
      [`login:email:${email}`, LIMITS.loginPerEmail],
      [`login:ip:${clientIp(c.req.raw)}`, LIMITS.loginPerIp],
    );
    if (!permitted) return tooMany(c);
    const business = parsed.success
      ? await businesses.getByEmail(parsed.data.email.trim())
      : undefined;
    const ok =
      business && (await verifyPassword(parsed.data!.password, business.owner.password_hash));
    if (!ok) {
      return c.json({ error: { code: 'unauthorized', message: 'Wrong email or password.' } }, 401);
    }
    return c.json({ token: sessionToken(business), business_id: business.id });
  });

  // ---------------------------------------------------------------- Password reset, email check

  // No analytics snippet here: the emailed link carries the reset token in the URL fragment.
  app.get('/reset', (c) =>
    c.html(
      resetHtml({
        forgotApi: '/api/password/forgot',
        resetApi: '/api/password/reset',
        studioPath: STUDIO_PATH,
      }),
    ),
  );

  app.post('/api/password/forgot', async (c) => {
    const parsed = ForgotInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return err(c, parsed.error);
    const email = parsed.data.email.trim().toLowerCase();
    if (!options.mail) {
      return err(
        c,
        new BookingError(
          'operation_not_supported',
          'Password reset by email is not set up on this server. Contact the operator.',
        ),
      );
    }
    const permitted = await allowed(
      [`reset:email:${email}`, LIMITS.resetEmailPerEmail],
      [`reset:ip:${clientIp(c.req.raw)}`, LIMITS.resetEmailPerIp],
    );
    if (!permitted) return tooMany(c);
    const business = await businesses.getByEmail(email);
    if (business) {
      const subject = `${business.id}:${passwordTag(business.owner.password_hash)}`;
      const url = `${baseUrl}/reset#token=${encodeURIComponent(signer.sign('reset', subject, RESET_TTL_MS))}`;
      try {
        await options.mail.mailer.send(resetEmail(business.owner.email, options.mail.from, url));
      } catch (e) {
        console.error('[openbooking] reset email failed', e);
      }
    }
    // Same answer either way, so the form can't be used to find out who has an account.
    return c.json({
      ok: true,
      message: 'If that email has an account, a reset link is on its way. Check your inbox.',
    });
  });

  app.post('/api/password/reset', async (c) => {
    if (!(await allowed([`reset-submit:ip:${clientIp(c.req.raw)}`, LIMITS.resetSubmitPerIp]))) {
      return tooMany(c);
    }
    const parsed = ResetInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return err(c, parsed.error);
    const invalid = () =>
      err(
        c,
        new BookingError(
          'validation_error',
          'This reset link has expired or was already used. Ask for a new one.',
        ),
      );
    const subject = signer.verify('reset', parsed.data.token);
    const [id, tag] = subject?.split(':') ?? [];
    if (!id || !tag) return invalid();
    const hash = await hashPassword(parsed.data.password);
    let used = false;
    const saved = await businesses.update(id, (b) => {
      if (passwordTag(b.owner.password_hash) !== tag) {
        used = true;
        return b;
      }
      return {
        ...b,
        owner: {
          ...b.owner,
          password_hash: hash,
          // They read the reset email, so the address is theirs.
          email_verified_at: b.owner.email_verified_at ?? clock.now().toISOString(),
          session_epoch: (b.owner.session_epoch ?? 0) + 1,
        },
      };
    });
    if (!saved || used) return invalid();
    tenants.get(id)?.sync(saved);
    track('password_reset', id);
    return c.json({ token: sessionToken(saved), business_id: id });
  });

  app.get('/api/verify-email', async (c) => {
    const subject = signer.verify('verify-email', c.req.query('token') ?? '');
    const sep = subject?.indexOf(':') ?? -1;
    if (!subject || sep < 0) return c.redirect(`${STUDIO_PATH}?verified=expired#settings`);
    const id = subject.slice(0, sep);
    const email = subject.slice(sep + 1);
    const saved = await businesses.update(id, (b) =>
      b.owner.email.toLowerCase() !== email || b.owner.email_verified_at
        ? b
        : { ...b, owner: { ...b.owner, email_verified_at: clock.now().toISOString() } },
    );
    if (saved) tenants.get(id)?.sync(saved);
    const verified = !!saved?.owner.email_verified_at && saved.owner.email.toLowerCase() === email;
    if (verified) {
      track('email_verified', id);
      options.ops?.notify(
        `:white_check_mark: *${businessName(saved!)}* confirmed their email and is now listed for AI assistants`,
      );
    }
    return c.redirect(`${STUDIO_PATH}?verified=${verified ? 'yes' : 'expired'}#settings`);
  });

  // ---------------------------------------------------------------- Studio

  app.get('/setup', (c) =>
    c.html(page(setupHtml({ studioPath: STUDIO_PATH, api: `${STUDIO_PATH}/api` }))),
  );
  app.get(STUDIO_PATH, (c) => c.html(page(STUDIO_HTML)));
  app.get(`${STUDIO_PATH}/`, (c) => c.redirect(STUDIO_PATH));

  // Every Studio API call: the session token decides which business's Studio answers.
  app.use(`${STUDIO_PATH}/api/*`, async (c, next) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const t = await sessionBusiness(token);
    if (!t) {
      return c.json(
        {
          error: {
            code: 'unauthorized',
            message: 'Log in to continue.',
            login: 'password',
            login_url: '/api/login',
            signup_url: '/signup',
            ...(options.mail ? { reset_url: '/reset' } : {}),
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

  app.post(`${STUDIO_PATH}/api/import`, async (c) => {
    const t = c.get('tenant');
    if (!(await allowed([`import:${t.id}`, { limit: 10, windowMs: 3_600_000 }]))) return tooMany(c);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return err(c, new BookingError('validation_error', 'Enter your website address.'));
    }
    try {
      const proposal = await importFromWebsite(body.url, {
        ...options.importer,
        currency: t.business.settings.profile.currency,
      });
      track('website_imported', t.id, {
        ok: true,
        sources: proposal.sources,
        services: proposal.services.length,
        opening_hours: !!proposal.opening_hours,
      });
      return c.json(proposal);
    } catch (e) {
      if (e instanceof ImportError) {
        track('website_imported', t.id, { ok: false });
        return err(c, new BookingError('validation_error', e.message));
      }
      throw e;
    }
  });

  app.post(`${STUDIO_PATH}/api/account/verify-email`, async (c) => {
    const t = c.get('tenant');
    if (!(await allowed([`verify:${t.id}`, LIMITS.resetEmailPerEmail]))) return tooMany(c);
    await sendVerification(t.business);
    return c.json({ ok: true, sent: !!options.mail && !t.business.owner.email_verified_at });
  });

  app.get(`${STUDIO_PATH}/api/account/export`, async (c) =>
    c.json(await c.get('tenant').exportData()),
  );

  app.post(`${STUDIO_PATH}/api/account/delete`, async (c) => {
    const t = c.get('tenant');
    if (!(await allowed([`delete:${t.id}`, { limit: 5, windowMs: 15 * 60_000 }])))
      return tooMany(c);
    const parsed = DeleteAccountInput.safeParse(await c.req.json().catch(() => null));
    const ok =
      parsed.success &&
      (await verifyPassword(parsed.data.password, t.business.owner.password_hash));
    if (!ok) {
      return c.json({ error: { code: 'forbidden', message: 'Wrong password.' } }, 403);
    }
    // Check before touching anything: half a deletion is worse than none.
    if (!deps.bookings.deleteVenue || !deps.businesses.delete) {
      return err(
        c,
        new BookingError('operation_not_supported', 'This storage cannot delete accounts yet.'),
        501,
      );
    }
    await t.idle();
    await t.eraseData();
    tenants.delete(t.id);
    activity.delete(t.id);
    await t.close();
    track('account_deleted', t.id);
    options.ops?.notify(':wave: A business closed its account.');
    return c.json({ ok: true });
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
      track('google_calendar_connected', id);
      if (saved)
        options.ops?.notify(
          `:spiral_calendar_pad: *${businessName(saved)}* connected Google Calendar`,
        );
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
      listBusinesses: async () =>
        (await businesses.list()).filter((b) => isListable(b, requireVerifiedEmail)),
      service: async (id) => {
        const b = await businesses.get(id);
        const t = b && isListable(b, requireVerifiedEmail) ? await tenant(id) : undefined;
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

  const retentionDays = options.retentionDays ?? 730;
  const purgeExpiredData = async () => {
    // Rate-limit windows are keyed by IP address; once a window is over there is no reason to keep it.
    await limiter.purge?.();
    const store = deps.bookings;
    if (!store.anonymize || retentionDays <= 0) return { businesses: 0, anonymized: 0 };
    const cutoff = new Date(clock.now().getTime() - retentionDays * 86_400_000);
    const all = await businesses.list();
    let anonymized = 0;
    for (const b of all) {
      const r = await store.anonymize({ venue_id: b.id, ended_before: cutoff }, clock.now());
      anonymized += r.anonymized;
    }
    return { businesses: all.length, anonymized };
  };
  app.get('/api/maintenance/purge', async (c) => {
    const secret = options.cronSecret;
    if (!secret) return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return c.json({ error: { code: 'unauthorized', message: 'Wrong secret.' } }, 401);
    }
    return c.json({ ok: true, ...(await purgeExpiredData()) });
  });

  return {
    app,
    purgeExpiredData,
    tenant,
    businesses,
    idle: async () => {
      await Promise.all([...tenants.values()].map((t) => t.idle()));
      await Promise.all([...background]);
      await options.analytics?.flush();
      await options.ops?.flush();
    },
    close: async () => {
      await Promise.all([...tenants.values()].map((t) => t.close()));
      await directory.close();
    },
  };
}

/** Booking operations worth counting, by engine operation. */
const BOOKING_EVENTS: Partial<Record<BookingEvent['operation'], string>> = {
  hold: 'slot_held',
  confirm: 'booking_confirmed',
  cancel: 'booking_cancelled',
};

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
