import { timingSafeEqual } from 'node:crypto';
import {
  BookingError,
  clientIpFromHeaders,
  formatMoney,
  isBookingError,
  runAsActor,
  toErrorPayload,
  type Booking,
  type BookingService,
  type ErrorPayload,
  type Resource,
  type Slot,
} from '@openbooking-sh/core';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { embedScript } from './embed';
import {
  jsonLd,
  readPrefill,
  renderManage,
  renderPage,
  type PageProfile,
  type StaffOption,
} from './render';

export interface BookingPageOptions {
  service: BookingService;
  /** Absolute public URL where the page is served, e.g. https://app.openbooking.sh/b/studio-nord. */
  pageUrl: string;
  /**
   * Absolute URL where this router is mounted, e.g. https://app.openbooking.sh/b/studio-nord/book.
   * The page calls `<path of apiBase>/api/...`.
   */
  apiBase: string;
  /** MCP endpoint, shown as "book with an AI assistant". */
  mcpUrl?: string;
  profile?: () => PageProfile | Promise<PageProfile>;
}

export interface BookingPage {
  /** Routes: `/`, `/manage/:id`, `/llms.txt`, `/embed.js`, `/api/*`. Mount at the path of `apiBase`. */
  app: Hono;
  /** `embed.js` for the business's own website (see embed.ts). */
  embed(): Promise<string>;
  /** The booking page HTML. `query` holds pre-fill parameters (see readPrefill). */
  html(query?: Record<string, string | undefined>): Promise<string>;
  /** Link customers use to view or cancel a booking (undefined until it has a confirmation code). */
  manageUrl(booking: Booking): string | undefined;
  /** Canonical public URL of the page. */
  pageUrl: string;
}

const HTTP: Partial<Record<ErrorPayload['code'], ContentfulStatusCode>> = {
  validation_error: 400,
  not_found: 404,
  slot_unavailable: 409,
  idempotency_conflict: 409,
  provider_error: 503,
  operation_not_supported: 501,
};

/**
 * The public booking page of one business: a page people (and browser agents, via WebMCP) can
 * book on, plus the small JSON API it runs on. Every call goes through the BookingService, so the
 * page gets the same safety rules as the agent protocols, and Studio shows it as its own channel.
 */
export function createBookingPage(options: BookingPageOptions): BookingPage {
  const { service } = options;
  const pageUrl = options.pageUrl.replace(/\/+$/, '');
  const apiBase = options.apiBase.replace(/\/+$/, '');
  const apiPath = new URL(apiBase).pathname.replace(/\/+$/, '');
  const app = new Hono();

  const profile = async (): Promise<PageProfile> => (await options.profile?.()) ?? {};

  const catalog = async () => {
    const venue = await service.resolveVenue();
    const [offerings, resources] = await Promise.all([
      service.listOfferings(venue.id),
      service.listResources(venue.id),
    ]);
    return { venue, offerings, resources, staff: staffOf(resources) };
  };

  const manageUrl = (b: Booking) =>
    b.confirmation_code
      ? `${apiBase}/manage/${encodeURIComponent(b.booking_id)}?code=${encodeURIComponent(b.confirmation_code)}`
      : undefined;

  const html = async (query: Record<string, string | undefined> = {}) => {
    const [cat, prof] = await Promise.all([catalog(), profile()]);
    return renderPage({
      venue: cat.venue,
      offerings: cat.offerings,
      staff: cat.staff,
      showParty: cat.resources.some((r) => r.capacity.max > 1),
      profile: prof,
      pageUrl,
      apiPath,
      ...(options.mcpUrl ? { mcpUrl: options.mcpUrl } : {}),
      prefill: readPrefill(query, cat),
    });
  };

  const json = async <T extends object>(c: Context, fn: () => Promise<T>) => {
    c.header('Cache-Control', 'no-store');
    const agent =
      c.req.header('x-openbooking-agent')?.toLowerCase() === 'webmcp'
        ? 'Browser agent'
        : 'Booking page';
    try {
      const ip = clientIpFromHeaders(c.req.raw.headers);
      return c.json(await runAsActor({ protocol: 'web', agent, ...(ip ? { ip } : {}) }, fn));
    } catch (e) {
      const error = toErrorPayload(e);
      return c.json({ error }, HTTP[error.code] ?? 422);
    }
  };

  const body = async (c: Context) =>
    (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  /** Load a booking only for someone holding its confirmation code; otherwise "not found". */
  const withCode = async (id: string, code: unknown) => {
    const missing = () => new BookingError('not_found', 'No booking found for this link.');
    let booking: Booking;
    try {
      booking = await service.getBooking(id);
    } catch (e) {
      if (isBookingError(e) && e.code === 'not_found') throw missing();
      throw e;
    }
    if (!booking.confirmation_code || !sameCode(booking.confirmation_code, code)) throw missing();
    return booking;
  };

  const embed = async () => {
    const [cat, prof] = await Promise.all([catalog(), profile()]);
    return embedScript({
      name: cat.venue.name,
      page_url: pageUrl,
      api_url: `${apiBase}/api`,
      json_ld: jsonLd({
        venue: cat.venue,
        offerings: cat.offerings,
        staff: cat.staff,
        showParty: false,
        profile: prof,
        pageUrl,
        apiPath,
        prefill: {},
      }),
    });
  };

  // The public booking API is called from businesses' own websites (embed.js WebMCP tools), so
  // allow any origin. No cookies are involved; every write still needs a slot id, an idempotency
  // key and, to confirm, explicit consent.
  app.use('/api/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Vary', 'Origin');
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'content-type, x-openbooking-agent');
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }
    await next();
  });

  app.get('/embed.js', async (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    // Short cache: a renamed service or new staff member shows up within minutes.
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(await embed());
  });

  app.get('/', async (c) => c.html(await html(c.req.query())));

  app.get('/manage/:id', async (c) => {
    const [venue, prof] = await Promise.all([service.resolveVenue(), profile()]);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(renderManage({ venue, profile: prof, pageUrl, apiPath }));
  });

  app.get('/llms.txt', async (c) => {
    const [cat, prof] = await Promise.all([catalog(), profile()]);
    return c.text(llmsTxt({ ...cat, profile: prof, pageUrl, mcpUrl: options.mcpUrl }));
  });

  app.get('/api/info', (c) =>
    json(c, async () => {
      const [{ venue, offerings, staff }, prof] = await Promise.all([catalog(), profile()]);
      return {
        venue: {
          name: venue.name,
          description: venue.description ?? null,
          address: venue.address ?? null,
          phone_number: venue.phone_number ?? null,
          timezone: venue.timezone,
          currency: venue.currency ?? null,
        },
        services: offerings.map((o) => ({
          id: o.id,
          name: o.name,
          description: o.description ?? null,
          duration_minutes: o.duration_minutes,
          price: o.price_per_person,
        })),
        staff,
        profile: prof,
        booking_page: pageUrl,
      };
    }),
  );

  app.get('/api/availability', (c) =>
    json(c, async () => {
      const q = c.req.query();
      const { resources } = await catalog();
      const staff = q.staff ? resources.find((r) => r.id === q.staff) : undefined;
      if (q.staff && !staff) throw new BookingError('not_found', `Unknown staff "${q.staff}".`);
      const tag = staff ? uniqueTag(staff, resources) : undefined;
      const { slots } = await service.searchAvailability({
        date: q.date ?? '',
        party_size: { total: Number(q.party ?? 1) },
        ...(q.service ? { offering_id: q.service } : {}),
        ...(q.time_from ? { time_from: q.time_from } : {}),
        ...(q.time_to ? { time_to: q.time_to } : {}),
        ...(tag ? { tags: [tag] } : {}),
        limit: 50,
      });
      return {
        date: q.date,
        slots: slots.filter((s) => !staff || s.resource?.id === staff.id).map(slotView),
      };
    }),
  );

  app.post('/api/hold', (c) =>
    json(c, async () => {
      const b = await body(c);
      const booking = await service.hold({
        slot_id: String(b.slot_id ?? ''),
        idempotency_key: String(b.idempotency_key ?? ''),
      });
      return { booking: view(booking) };
    }),
  );

  /** Let go of a hold the visitor no longer wants (they picked another time). */
  app.post('/api/holds/:id/release', (c) =>
    json(c, async () => {
      const id = c.req.param('id');
      const booking = await service.getBooking(id).catch(() => null);
      if (booking?.status !== 'held') return { released: false };
      await service.cancel({ booking_id: id, idempotency_key: `page-release-${id}` });
      return { released: true };
    }),
  );

  app.post('/api/confirm', (c) =>
    json(c, async () => {
      const b = await body(c);
      const id = String(b.booking_id ?? '');
      const key = String(b.idempotency_key ?? '');
      const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
      if (notes && b.user_confirmed === true) {
        await service
          .update({ booking_id: id, idempotency_key: `${key}:notes`, notes })
          .catch((e) => {
            if (!(isBookingError(e) && e.code === 'operation_not_supported')) throw e;
          });
      }
      const booking = await service.confirm({
        booking_id: id,
        idempotency_key: key,
        user_confirmed: b.user_confirmed === true,
        customer: b.customer as never,
      });
      return { booking: { ...view(booking), manage_url: manageUrl(booking) ?? null } };
    }),
  );

  app.get('/api/bookings/:id', (c) =>
    json(c, async () => {
      const booking = await withCode(c.req.param('id'), c.req.query('code'));
      return { booking: view(booking, true) };
    }),
  );

  app.post('/api/bookings/:id/cancel', (c) =>
    json(c, async () => {
      const b = await body(c);
      const booking = await withCode(c.req.param('id'), b.code);
      try {
        const res = await service.cancel({
          booking_id: booking.booking_id,
          idempotency_key: String(b.idempotency_key ?? ''),
          user_confirmed: b.user_confirmed === true,
          reason: 'Cancelled by the customer on the booking page',
        });
        return { booking: view(res.booking, true) };
      } catch (e) {
        if (isBookingError(e) && e.code === 'user_confirmation_required') {
          // Same rule as the agents get, in words for the customer.
          const d = e.details as {
            fee?: { amount: number; currency: string } | null;
            free?: boolean;
          };
          throw new BookingError(
            'user_confirmation_required',
            d?.free || !d?.fee
              ? 'Cancelling is free.'
              : `Cancelling now costs ${formatMoney(d.fee)}.`,
            { ...(e.details ? { details: e.details } : {}) },
          );
        }
        throw e;
      }
    }),
  );

  return { app, embed, html, manageUrl, pageUrl };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function staffOf(resources: Resource[]): StaffOption[] {
  return resources.filter((r) => r.kind === 'staff').map((r) => ({ id: r.id, name: r.name }));
}

/** A tag only this resource has, so a search can be narrowed to it. */
function uniqueTag(r: Resource, all: Resource[]): string | undefined {
  return r.tags.find((t) => !all.some((o) => o.id !== r.id && o.tags.includes(t)));
}

function slotView(s: Slot) {
  return {
    slot_id: s.slot_id,
    start: s.start,
    end: s.end,
    offering: s.offering,
    resource: s.resource ? { id: s.resource.id ?? null, label: s.resource.label } : null,
    price: s.price,
    deposit: s.deposit,
    cancellation_policy: s.cancellation_policy,
  };
}

function view(b: Booking, withCustomer = false) {
  return {
    booking_id: b.booking_id,
    status: b.status,
    start: b.slot.start,
    end: b.slot.end,
    expires_at: b.status === 'held' ? b.expires_at : null,
    offering: b.slot.offering,
    resource: b.slot.resource?.label ?? null,
    party_size: b.slot.party_size.total,
    price: b.slot.price,
    deposit: b.slot.deposit,
    cancellation_policy: b.slot.cancellation_policy,
    confirmation_code: b.confirmation_code,
    ...(withCustomer
      ? {
          customer: b.customer
            ? { first_name: b.customer.first_name, last_name: b.customer.last_name }
            : null,
          cancellation: b.cancellation,
        }
      : {}),
  };
}

function sameCode(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected.toUpperCase());
  const b = Buffer.from(given.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

function llmsTxt(m: {
  venue: { name: string; description?: string; phone_number?: string };
  offerings: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    price_per_person: { amount: number; currency: string } | null;
  }>;
  staff: StaffOption[];
  profile: PageProfile;
  pageUrl: string;
  mcpUrl: string | undefined;
}): string {
  const lines = [
    `# ${m.venue.name}`,
    '',
    ...(m.venue.description ? [`> ${m.venue.description}`, ''] : []),
    `Book online: ${m.pageUrl}`,
    ...(m.venue.phone_number ? [`Phone: ${m.venue.phone_number}`] : []),
    '',
    '## Services',
    '',
    ...m.offerings.map(
      (o) =>
        `- ${o.name} (id: ${o.id}): ${o.duration_minutes} min${o.price_per_person ? `, ${formatMoney(o.price_per_person)}` : ''}`,
    ),
    ...(m.staff.length
      ? ['', '## Staff', '', ...m.staff.map((s) => `- ${s.name} (id: ${s.id})`)]
      : []),
    '',
    '## How to book',
    '',
    ...(m.mcpUrl
      ? [
          `- AI assistants with MCP: connect to ${m.mcpUrl} (tools: search_availability, hold_slot, confirm_booking, get_booking, cancel_booking).`,
        ]
      : []),
    `- Send the user a pre-filled booking link: ${m.pageUrl}?service=<service id>&date=YYYY-MM-DD&time=HH:MM`,
    '  Optional parameters: staff=<staff id>, party=<guests>, first_name, last_name, email, phone.',
    '  The page shows the requested time if it is free; the user confirms the booking themselves.',
    '',
  ];
  return lines.join('\n');
}
