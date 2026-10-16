import {
  buildAgentCard,
  createA2AAdapter,
  AGENT_CARD_PATH,
  type AgentProvider,
} from '@openbooking-sh/adapter-a2a';
import { createMcpHttpHandler } from '@openbooking-sh/adapter-mcp';
import {
  createBookingPage,
  type BookingPage,
  type BookingPageOptions,
} from '@openbooking-sh/booking-page';
import { buildUcpProfile, createUcpRouter } from '@openbooking-sh/adapter-ucp';
import {
  createUsp,
  type ConsentMode,
  type ProfileFetcher,
  type UspBusinessAuth,
  type UspStateStore,
} from '@openbooking-sh/adapter-usp';
import {
  BookingService,
  createWebhooks,
  runAsActor,
  type BookingProvider,
  type BookingServiceOptions,
  type WebhookOptions,
  type Webhooks,
} from '@openbooking-sh/core';
import {
  actorFromRequest,
  createStudio,
  type ActivityLog,
  type Studio,
} from '@openbooking-sh/studio';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/hono';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';

export interface OpenBookingServerOptions {
  /** The booking system. Ignored if `service` is given. */
  provider?: BookingProvider;
  /** Pre-built service (to share one across apps or inject a clock/idempotency store). */
  service?: BookingService;
  /** Options for the BookingService created from `provider`. */
  serviceOptions?: Omit<BookingServiceOptions, 'provider'>;
  /** Public origin clients use, e.g. `https://bistro.example.com`. Used in discovery documents. */
  baseUrl: string;
  name?: string;
  description?: string;
  version?: string;
  /** Organization operating the agent (A2A `provider`). */
  organization?: AgentProvider;
  /** Mount paths; pass `false` to disable an adapter. */
  mcpPath?: string | false;
  ucpPath?: string | false;
  a2aPath?: string | false;
  /**
   * USP (Universal Scheduling Protocol, a draft standard from Wix and Stripe): lets any platform
   * or AI assistant discover and book this business, authenticating with its own key. Off unless
   * you pass options (`usp: {}` for the defaults).
   *
   * By default a booking an assistant makes is only held: the customer confirms it on the
   * booking page (`consent: 'action'`, needs the booking page). With `consent: 'commit'` the
   * assistant's request confirms it, trusting that the assistant asked its user first.
   *
   * `state` remembers who owns what, credentials and replay protection. In memory by default;
   * with more than one server instance pass a shared store, e.g. `postgresStores(db).usp`.
   */
  usp?:
    | {
        path?: string;
        consent?: ConsentMode;
        state?: UspStateStore;
        /** Staff-only calls (confirming a booking by hand). Refused when not set. */
        businessAuth?: UspBusinessAuth;
        /** Stable id of the business in USP. Default: the host of `baseUrl`. */
        businessId?: string;
        /**
         * How platform profiles are fetched. Default: a hardened fetcher that only reaches the
         * public internet. Pass one to share its cache across businesses, or `false` to not fetch
         * profiles (no capability negotiation: for local development and tests).
         */
        platformProfiles?: ProfileFetcher | false;
      }
    | false;
  /**
   * Host header allow-list for the MCP endpoint (DNS-rebinding protection). Defaults to the host of
   * `baseUrl` plus localhost/127.0.0.1. Pass `false` to disable (e.g. behind a trusted proxy).
   */
  allowedHosts?: string[] | false;
  /**
   * OpenBooking Studio dashboard at `studioPath` (default /studio). Requires `token` unless
   * baseUrl is localhost (local development). `activity` makes its log durable (e.g. Postgres).
   * Pass `false` to disable.
   */
  studio?: { token?: string; path?: string; activity?: ActivityLog } | false;
  /**
   * Public booking page at `path` (default /book). Requests for `/` that don't ask for JSON get
   * the page too, so a single-business deployment's root is its booking page. Pass `false` to
   * disable.
   */
  bookingPage?:
    | {
        path?: string;
        /** Canonical public URL of the page when it isn't `baseUrl + path` (e.g. behind a rewrite). */
        pageUrl?: string;
        profile?: BookingPageOptions['profile'];
        /** Privacy policy linked in the booking page footer. */
        privacyUrl?: string;
      }
    | false;
  /**
   * Signed webhooks for booking.held, .confirmed, .updated and .cancelled. On serverless hosts,
   * keep the function alive for `webhooks.idle()` (e.g. `waitUntil`) so retries can finish.
   */
  webhooks?: WebhookOptions;
}

export interface OpenBookingApp {
  app: Hono;
  service: BookingService;
  studio: Studio | undefined;
  bookingPage: BookingPage | undefined;
  webhooks: Webhooks | undefined;
  close(): Promise<void>;
}

/**
 * One HTTP app exposing a BookingProvider over every supported agent protocol:
 *
 *   GET  /                              index (links to everything below); the booking page for browsers
 *   *    /book/...                      public booking page, its JSON API and manage links
 *   ALL  /mcp                           MCP Streamable HTTP (6 booking tools)
 *   *    /ucp/...                       UCP lodging booking-session REST (+ availability extension)
 *   GET  /.well-known/ucp               UCP business profile
 *   *    /usp/...                       USP catalog, availability, holds, bookings (when `usp` is set)
 *   GET  /.well-known/usp               USP business profile (when `usp` is set)
 *   GET  /.well-known/agent-card.json   A2A Agent Card
 *   POST /a2a                           A2A JSON-RPC (SendMessage)
 *   GET  /healthz
 */
export function createOpenBookingApp(options: OpenBookingServerOptions): OpenBookingApp {
  const service =
    options.service ??
    (options.provider
      ? new BookingService({ provider: options.provider, ...options.serviceOptions })
      : undefined);
  if (!service) throw new Error('createOpenBookingApp: pass either `provider` or `service`.');
  const webhooks = options.webhooks ? createWebhooks(options.webhooks) : undefined;
  const offWebhooks = webhooks ? service.on(webhooks.listener) : undefined;

  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const name = options.name ?? service.provider.info.name;
  const description =
    options.description ?? service.provider.info.description ?? `Book with ${name} via AI agents.`;
  const version = options.version ?? '0.1.0';
  const mcpPath = options.mcpPath ?? '/mcp';
  const ucpPath = options.ucpPath ?? '/ucp';
  const a2aPath = options.a2aPath ?? '/a2a';

  const app = new Hono();
  let mcpHandler: McpHttpHandler | undefined;

  app.get('/healthz', (c) => c.json({ ok: true }));

  const pagePath = options.bookingPage === false ? false : (options.bookingPage?.path ?? '/book');
  const page = pagePath
    ? createBookingPage({
        service,
        pageUrl: (options.bookingPage && options.bookingPage.pageUrl) || `${baseUrl}${pagePath}`,
        apiBase: `${baseUrl}${pagePath}`,
        ...(mcpPath ? { mcpUrl: `${baseUrl}${mcpPath}` } : {}),
        ...(options.bookingPage && options.bookingPage.profile
          ? { profile: options.bookingPage.profile }
          : {}),
        ...(options.bookingPage && options.bookingPage.privacyUrl
          ? { privacyUrl: options.bookingPage.privacyUrl }
          : {}),
      })
    : undefined;

  app.get('/', async (c) => {
    // The page for anyone who doesn't ask for JSON: several AI crawlers send `Accept: */*` or none,
    // and should see the business, its services and schema.org data rather than the discovery JSON.
    c.header('Vary', 'Accept');
    const accept = c.req.header('accept') ?? '';
    const wantsJson = accept.includes('application/json') && !accept.includes('text/html');
    if (page && !wantsJson) {
      return c.html(await page.html(c.req.query()));
    }
    return c.json({
      name,
      description,
      ...(page ? { booking_page: page.pageUrl } : {}),
      protocols: {
        ...(mcpPath ? { mcp: { status: 'supported', endpoint: `${baseUrl}${mcpPath}` } } : {}),
        ...(ucpPath
          ? {
              ucp: {
                status: 'draft',
                profile: `${baseUrl}/.well-known/ucp`,
                endpoint: `${baseUrl}${ucpPath}`,
              },
            }
          : {}),
        ...(options.usp
          ? {
              usp: {
                status: 'draft',
                profile: `${baseUrl}/.well-known/usp`,
                endpoint: `${baseUrl}${options.usp.path ?? '/usp'}`,
              },
            }
          : {}),
        ...(a2aPath
          ? { a2a: { status: 'supported', agent_card: `${baseUrl}${AGENT_CARD_PATH}` } }
          : {}),
      },
    });
  });

  if (page && pagePath) app.route(pagePath, page.app);
  // Short URL for the website snippet: <script src="{baseUrl}/embed.js" async></script>
  if (page && pagePath) {
    app.get('/embed.js', (c) => page.app.fetch(new Request(new URL('/embed.js', c.req.url))));
  }

  if (mcpPath) {
    mcpHandler = createMcpHttpHandler({ service, name: 'openbooking', version });
    const handler = mcpHandler;
    if (options.allowedHosts !== false) {
      const hosts = options.allowedHosts ?? [
        new URL(baseUrl).hostname,
        'localhost',
        '127.0.0.1',
        '[::1]',
      ];
      app.use(mcpPath, hostHeaderValidation(hosts), originValidation(hosts));
    }
    // Every tool call runs as the calling agent, so Studio can show who booked what.
    app.all(mcpPath, async (c) =>
      runAsActor(await actorFromRequest(c.req.raw, 'mcp'), () => handler.fetch(c.req.raw)),
    );
  }

  if (ucpPath) {
    app.use(`${ucpPath}/*`, async (c, next) =>
      runAsActor(await actorFromRequest(c.req.raw, 'ucp'), () => next()),
    );
    app.route(ucpPath, createUcpRouter({ service, baseUrl, ucpPath }));
    app.get('/.well-known/ucp', (c) => {
      c.header('Cache-Control', 'public, max-age=300');
      return c.json(buildUcpProfile({ baseUrl, ucpPath }));
    });
  }

  if (options.usp) {
    const consent = options.usp.consent ?? 'action';
    if (consent === 'action' && !page) {
      throw new Error(
        "createOpenBookingApp: usp consent 'action' sends the customer to the booking page to " +
          "confirm, so it needs the booking page. Enable it, or set usp.consent to 'commit'.",
      );
    }
    const usp = createUsp({
      service,
      baseUrl,
      name,
      consent,
      ...(options.usp.path ? { path: options.usp.path } : {}),
      ...(options.usp.state ? { state: options.usp.state } : {}),
      ...(options.usp.businessAuth ? { businessAuth: options.usp.businessAuth } : {}),
      ...(options.usp.businessId ? { businessId: options.usp.businessId } : {}),
      ...(options.usp.platformProfiles !== undefined
        ? { platformProfiles: options.usp.platformProfiles }
        : {}),
      ...(page ? { continueUrl: page.confirmUrl, bookingUrl: page.manageUrl } : {}),
    });
    app.use(`${usp.path}/*`, async (c, next) =>
      runAsActor(await actorFromRequest(c.req.raw, 'usp'), () => next()),
    );
    app.route(usp.path, usp.router);
    app.get('/.well-known/usp', async (c) => {
      // USP 8.2.2: public, cacheable for at least a minute, never no-store.
      c.header('Cache-Control', 'public, max-age=300');
      return c.json(await usp.profile());
    });
  }

  if (a2aPath) {
    const a2a = createA2AAdapter({ service });
    app.post(a2aPath, async (c) =>
      runAsActor(await actorFromRequest(c.req.raw, 'a2a'), () => a2a.fetch(c.req.raw)),
    );
    app.get(AGENT_CARD_PATH, (c) => {
      // A2A §8.6: SHOULD send Cache-Control with max-age.
      c.header('Cache-Control', 'public, max-age=300');
      return c.json(
        buildAgentCard({
          name,
          description,
          baseUrl,
          a2aPath,
          version,
          ...(options.organization ? { provider: options.organization } : {}),
          ...(mcpPath ? { mcpUrl: `${baseUrl}${mcpPath}` } : {}),
        }),
      );
    });
  }

  let studio: Studio | undefined;
  if (options.studio !== false) {
    const studioPath = options.studio?.path ?? '/studio';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
    const token = options.studio?.token;
    const activity = options.studio?.activity;
    studio = createStudio({
      service,
      name,
      ...(activity ? { activity } : {}),
      ...(token ? { token } : { insecureNoAuth: local }),
    });
    app.get(`${studioPath}/`, (c) => c.redirect(studioPath));
    app.route(studioPath, studio.app);
  }

  return {
    app,
    service,
    studio,
    bookingPage: page,
    webhooks,
    close: async () => {
      offWebhooks?.();
      await webhooks?.idle();
      await studio?.idle();
      studio?.close();
      await mcpHandler?.close();
    },
  };
}
