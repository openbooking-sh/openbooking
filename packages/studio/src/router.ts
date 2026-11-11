import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BookingError,
  formatMoney,
  fromZodError,
  runAsActor,
  time,
  toErrorPayload,
  type Booking,
  type BookingService,
  type ErrorPayload,
} from '@openbooking-sh/core';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ActivityStore, recordActivity, type ActivityLog } from './activity';
import { CustomerMatchSchema, type DataRightsAdapter } from './data-rights';
import { paymentSummary } from './payment-summary';
import { BusinessSettingsSchema, type StudioSettingsAdapter } from './settings';
import { bookingsCsv, countBySource, sourceDetail, sourceLabel } from './sources';
import { computeOverview } from './stats';
import { studioHtml, type StudioLegal } from './ui';

export interface StudioOptions {
  service: BookingService;
  /**
   * Bearer token required for the Studio API. Strongly recommended: the Studio shows customer
   * names and contact details.
   */
  token?: string;
  /**
   * Allow access without a token. Only for local development; the server enables this
   * automatically when its baseUrl is localhost. Never derive this from request headers.
   */
  insecureNoAuth?: boolean;
  /** Where activity and booked-via attribution live. Defaults to an in-memory ring buffer. */
  activity?: ActivityLog;
  /** Display name in the Studio header. */
  name?: string;
  /** Lets the owner edit business settings in Studio (hosted OpenBooking). */
  settings?: StudioSettingsAdapter;
  /** Lets the owner download or delete one customer's data from Studio. */
  dataRights?: DataRightsAdapter;
  /** Policies linked in the Studio footer (hosted OpenBooking sets them). */
  legal?: StudioLegal;
}

export interface Studio {
  app: Hono;
  activity: ActivityLog;
  /** Resolves once all activity seen so far is written. */
  idle(): Promise<void>;
  close(): void;
}

const HTTP: Partial<Record<ErrorPayload['code'], ContentfulStatusCode>> = {
  validation_error: 400,
  not_found: 404,
  operation_not_supported: 501,
};

const STUDIO_ACTOR = { protocol: 'studio' as const, agent: 'Studio' };

/**
 * OpenBooking Studio: a dashboard for the people running the bookable business.
 * Mount with `app.route('/studio', createStudio({ service, token }).app)`.
 */
export function createStudio(options: StudioOptions): Studio {
  const { service } = options;
  const activity = options.activity ?? new ActivityStore();
  const recorder = recordActivity(service, activity);
  const app = new Hono();

  const tokenBuf = options.token ? Buffer.from(options.token) : null;
  const authorized = (c: Context) => {
    if (tokenBuf) {
      const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
      return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
    }
    return options.insecureNoAuth === true;
  };

  const json = async <T>(c: Context, fn: () => Promise<T>) => {
    try {
      // Read-your-writes: activity from earlier requests is persisted before we answer.
      await recorder.idle();
      return c.json((await runAsActor(STUDIO_ACTOR, fn)) as object);
    } catch (e) {
      const error = toErrorPayload(e);
      return c.json({ error }, HTTP[error.code] ?? 500);
    }
  };

  const withVia = async (bookings: Booking[]) => {
    await recorder.idle();
    const via = await activity.bookedVia(bookings.map((b) => b.booking_id));
    // Broker-pattern flags are for the venue's staff: only this (authenticated) router shows them.
    const flags = await service.riskFlags(bookings.map((b) => b.booking_id));
    return bookings.map((b) => ({
      ...b,
      booked_via: via.get(b.booking_id) ?? null,
      source_label: sourceLabel(b.source),
      source_detail: sourceDetail(b.source),
      ...(flags.has(b.booking_id) ? { risk_flags: flags.get(b.booking_id) } : {}),
    }));
  };
  const oneWithVia = async (b: Booking) => (await withVia([b]))[0]!;

  /** Bookings by ?status=, ?source= (a Studio source name such as ChatGPT or Phone) and ?limit=. */
  const listFiltered = async (c: Context, defaultLimit = 200) => {
    const status = c.req.query('status');
    const source = c.req.query('source');
    const limit = Number(c.req.query('limit') ?? defaultLimit);
    const list = await service.listBookings({
      ...(status ? { status: status.split(',') as Booking['status'][] } : {}),
      // A source filter applies after listing, so take everything first and cut afterwards.
      limit: source ? 5000 : limit,
    });
    return source ? list.filter((b) => sourceLabel(b.source) === source).slice(0, limit) : list;
  };

  const html = studioHtml(options.legal);
  app.get('/', (c) => c.html(html));

  app.use('/api/*', async (c, next) => {
    if (!authorized(c)) {
      return c.json(
        {
          error: {
            code: 'unauthorized',
            message: tokenBuf
              ? 'Missing or wrong Studio token.'
              : 'Studio is locked. Start the server with a Studio token (e.g. STUDIO_TOKEN) to use it.',
          },
        },
        401,
      );
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/api/session', (c) =>
    json(c, async () => {
      const venues = await service.listVenues();
      return {
        name: options.name ?? service.provider.info.name,
        venues,
        hold_ttl_seconds: service.holdTtlSeconds,
        settings: !!options.settings,
        data_rights: !!options.dataRights,
      };
    }),
  );

  app.get('/api/overview', (c) =>
    json(c, async () => {
      const [venue] = await service.listVenues();
      let bookings: Booking[] = [];
      let listing = true;
      try {
        bookings = await service.listBookings({ limit: 5000 });
      } catch {
        listing = false;
      }
      return {
        listing_supported: listing,
        ...computeOverview(
          bookings,
          await activity.list({ limit: 5000 }),
          service.clock.now(),
          venue?.timezone ?? 'UTC',
        ),
        recent_bookings: await withVia(bookings.slice(0, 6)),
      };
    }),
  );

  app.get('/api/bookings', (c) =>
    json(c, async () => {
      const list = await listFiltered(c);
      return { bookings: await withVia(list) };
    }),
  );

  // The same filters as the list, as a spreadsheet. Only what the list shows: no contact details.
  app.get('/api/export/bookings.csv', async (c) => {
    if (!authorized(c))
      return c.json({ error: { code: 'unauthorized', message: 'Unauthorized' } }, 401);
    try {
      await recorder.idle();
      const [venue] = await service.listVenues();
      const list = await runAsActor(STUDIO_ACTOR, () => listFiltered(c, 5000));
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', 'attachment; filename="bookings.csv"');
      c.header('Cache-Control', 'no-store');
      return c.body(bookingsCsv(list, venue?.timezone ?? 'UTC'));
    } catch (e) {
      const error = toErrorPayload(e);
      return c.json({ error }, HTTP[error.code] ?? 500);
    }
  });

  // Bookings per source for bookings created between two dates (venue-local, inclusive).
  app.get('/api/sources', (c) =>
    json(c, async () => {
      const [venue] = await service.listVenues();
      const { from, to } = c.req.query();
      for (const d of [from, to]) {
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          throw new BookingError('validation_error', 'from and to must be dates like 2026-11-01.');
        }
      }
      const list = await service.listBookings({ limit: 5000 });
      return {
        from: from ?? null,
        to: to ?? null,
        sources: countBySource(list, venue?.timezone ?? 'UTC', { from, to }),
      };
    }),
  );

  app.get('/api/bookings/:id', (c) =>
    json(c, async () => {
      const id = c.req.param('id');
      const booking = await service.getBooking(id);
      return {
        booking: await oneWithVia(booking),
        payment_summary: paymentSummary(booking),
        activity: await activity.list({ booking_id: id, limit: 50 }),
      };
    }),
  );

  app.post('/api/bookings/:id/cancel', (c) =>
    json(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
      const id = c.req.param('id');
      const { booking } = await service.cancel({
        booking_id: id,
        // Staff action: one key per click is fine; cancel is state-idempotent anyway.
        idempotency_key: `studio-cancel-${id}-${Date.now()}`,
        user_confirmed: true,
        reason: body.reason ?? 'Cancelled by staff in Studio',
      });
      return { booking: await oneWithVia(booking) };
    }),
  );

  if (options.settings) {
    const settings = options.settings;
    app.get('/api/settings', (c) => json(c, () => settings.get()));
    app.put('/api/settings', (c) =>
      json(c, async () => {
        const parsed = BusinessSettingsSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) throw fromZodError(parsed.error, 'settings');
        return settings.update(parsed.data);
      }),
    );
  }

  if (options.dataRights) {
    const rights = options.dataRights;
    // POST, not GET: an email address or phone number must not end up in URLs and access logs.
    const customer = async (c: Context) => {
      const parsed = CustomerMatchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw fromZodError(parsed.error, 'customer');
      return parsed.data;
    };
    app.post('/api/customers/export', (c) =>
      json(c, async () => {
        const who = await customer(c);
        return {
          exported_at: service.clock.now().toISOString(),
          customer: who,
          bookings: await rights.exportCustomer(who),
        };
      }),
    );
    app.post('/api/customers/erase', (c) =>
      json(c, async () => rights.eraseCustomer(await customer(c))),
    );
  }

  app.get('/api/activity', (c) =>
    json(c, async () => {
      const after = c.req.query('after');
      return {
        activity: await activity.list({
          ...(after ? { after: Number(after) } : {}),
          limit: Number(c.req.query('limit') ?? 200),
        }),
      };
    }),
  );

  app.get('/api/availability', (c) =>
    json(c, async () => {
      const q = c.req.query();
      return service.searchAvailability({
        date: q.date ?? '',
        party_size: { total: Number(q.party_size ?? 1) },
        ...(q.time_from ? { time_from: q.time_from } : {}),
        ...(q.time_to ? { time_to: q.time_to } : {}),
        ...(q.offering_id ? { offering_id: q.offering_id } : {}),
        limit: 50,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Booking-system views
  // -------------------------------------------------------------------------

  app.get('/api/catalog', (c) =>
    json(c, async () => {
      const [offerings, resources] = await Promise.all([
        service.listOfferings(),
        service.listResources(),
      ]);
      return { offerings, resources };
    }),
  );

  app.get('/api/calendar', (c) =>
    json(c, async () => {
      const [venue] = await service.listVenues();
      const tz = venue?.timezone ?? 'UTC';
      const date = c.req.query('date') ?? time.localDate(service.clock.now(), tz);
      const [resources, bookings] = await Promise.all([
        service.listResources(),
        service.listBookings({ status: ['held', 'confirmed'], limit: 5000 }),
      ]);
      return {
        date,
        timezone: tz,
        resources,
        bookings: await withVia(
          bookings
            .filter((b) => time.localDate(new Date(b.slot.start), tz) === date)
            .sort((a, b) => (a.slot.start < b.slot.start ? -1 : 1)),
        ),
      };
    }),
  );

  app.get('/api/customers', (c) =>
    json(c, async () => {
      const bookings = await service.listBookings({ limit: 5000 });
      const via = await activity.bookedVia(bookings.map((b) => b.booking_id));
      const map = new Map<
        string,
        {
          name: string;
          email: string | null;
          phone_number: string | null;
          bookings: number;
          spend: number;
          currency: string | null;
          last_visit: string | null;
          next_visit: string | null;
          first_source: string | null;
        }
      >();
      const now = service.clock.now().toISOString();
      // Oldest first so first_source is the channel the customer first came through.
      for (const b of [...bookings].reverse()) {
        const c = b.customer;
        if (!c) continue;
        const key = (c.email ?? c.phone_number ?? `${c.first_name} ${c.last_name}`).toLowerCase();
        const row = map.get(key) ?? {
          name: `${c.first_name} ${c.last_name}`,
          email: c.email ?? null,
          phone_number: c.phone_number ?? null,
          bookings: 0,
          spend: 0,
          currency: null,
          last_visit: null,
          next_visit: null,
          first_source: via.get(b.booking_id) ?? null,
        };
        if (b.status === 'confirmed') {
          row.bookings++;
          if (b.slot.price) {
            row.spend += b.slot.price.amount;
            row.currency = b.slot.price.currency;
          }
          if (b.slot.start < now) {
            if (!row.last_visit || b.slot.start > row.last_visit) row.last_visit = b.slot.start;
          } else if (!row.next_visit || b.slot.start < row.next_visit) {
            row.next_visit = b.slot.start;
          }
        }
        map.set(key, row);
      }
      return { customers: [...map.values()].sort((a, b) => b.bookings - a.bookings) };
    }),
  );

  /** Staff booking (phone, walk-in): hold + confirm in one step, credited to "Studio". */
  app.post('/api/bookings', (c) =>
    json(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as {
        slot_id?: string;
        customer?: unknown;
        notes?: string;
        deposit_collected?: boolean;
        idempotency_key?: string;
        /** How the guest reached the venue: chosen by the staff member. */
        source?: string;
      };
      const channel = body.source ?? 'other';
      if (!(['phone', 'walk_in', 'other'] as string[]).includes(channel)) {
        throw new BookingError('validation_error', 'source must be phone, walk_in or other.');
      }
      const key = body.idempotency_key ?? randomUUID();
      // The source is fixed here, at the hold: the staff member's pick becomes the booking's channel.
      const hold = await runAsActor(
        { ...STUDIO_ACTOR, channel: channel as 'phone' | 'walk_in' | 'other' },
        () =>
          service.hold({
            slot_id: body.slot_id ?? '',
            idempotency_key: `${key}:hold`,
            customer: body.customer as never,
            ...(body.notes ? { notes: body.notes } : {}),
          }),
      );
      const needsDeposit = hold.slot.deposit?.due === 'at_confirmation';
      if (needsDeposit && !body.deposit_collected) {
        await service.cancel({ booking_id: hold.booking_id, idempotency_key: `${key}:release` });
        throw new BookingError(
          'payment_required',
          `This service needs a deposit of ${formatMoney(hold.slot.deposit!.amount)}.`,
          { suggested_next_action: 'Collect the deposit and tick "Deposit collected".' },
        );
      }
      const booking = await service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: `${key}:confirm`,
        user_confirmed: true,
        ...(needsDeposit ? { payment_token: 'manual:collected-in-studio' } : {}),
      });
      return { booking: await oneWithVia(booking) };
    }),
  );

  return { app, activity, idle: recorder.idle, close: recorder.detach };
}
