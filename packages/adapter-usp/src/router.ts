/**
 * USP REST binding (spec section 9.1), mounted with
 * `app.route('/usp', createUspRouter({ service, baseUrl }))`.
 *
 *   POST /services/list             catalog search
 *   POST /services/lookup           service ids → services
 *   GET  /services/feed             501: this adapter does not offer a feed
 *   GET  /services/{service_id}     one service
 *   POST /availability/query        slots in a date range
 *
 * plus, when an authenticator is configured, holds and bookings (see bookings.ts). Without one,
 * every privileged operation answers 401 (spec 10.1.6).
 */
import {
  BookingError,
  time,
  type BookingService,
  type Offering,
  type Resource,
  type Slot,
  type Venue,
} from '@openbooking-sh/core';
import { Hono } from 'hono';
import * as z from 'zod';
import type { UspAuthenticator, UspBusinessAuth } from './auth';
import { registerBookingRoutes } from './bookings';
import type { Booking } from '@openbooking-sh/core';
import type { ConsentMode } from './booking-mapping';
import { USP } from './constants';
import { guard, parse, readBody } from './http';
import { MemoryUspState, type UspStateStore } from './state';
import {
  daysBetween,
  openingHours,
  parseServiceId,
  toService,
  toTimeSlot,
  type ServiceDetails,
} from './mapping';
import { envelope, message, problemResponse, ProtocolError, type UspMessage } from './protocol';

export interface UspRouterOptions {
  service: BookingService;
  /** Public origin, used for the default business id. */
  baseUrl: string;
  /** Stable id of the business in USP `Service.business_id`. Default: the host of `baseUrl`. */
  businessId?: string;
  /** Per-offering overrides (service type, description) until providers expose them. */
  serviceDetails?: (offering: Offering) => Partial<ServiceDetails>;
  /** Longest availability range one request may cover. Default 7 days (the spec's SHOULD). */
  maxRangeDays?: number;
  /**
   * How a USP booking becomes real. `action` (default): the buyer confirms on the business's page
   * (needs `continueUrl`). `commit`: creating the booking confirms it, trusting the platform to
   * have asked its user. See bookings.ts.
   */
  consent?: ConsentMode;
  /** Where a buyer confirms a held booking (consent `action`), e.g. `BookingPage.confirmUrl`. */
  continueUrl?: (booking: Booking) => string;
  /** Where the customer manages a confirmed booking, e.g. `BookingPage.manageUrl`. */
  bookingUrl?: (booking: Booking) => string | undefined;
  /** Authenticates platforms for holds and bookings. Without it those operations are refused. */
  auth?: UspAuthenticator;
  /** Authenticates the business's own staff for staff-only calls. Without it those are refused. */
  businessAuth?: UspBusinessAuth;
  /** What the adapter remembers (owners, conversions, idempotency keys). Default: in memory. */
  state?: UspStateStore;
}

const MAX_LOOKUP_IDS = 100;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

const AMOUNT = z.union([z.number().int(), z.string().regex(/^-?[0-9]+$/)]).transform(Number);

const ListRequest = z.object({
  filters: z
    .object({
      type: z.string().optional(),
      location_id: z.string().optional(),
      price: z.object({ min: AMOUNT.optional(), max: AMOUNT.optional() }).optional(),
    })
    .optional(),
  pagination: z
    .object({
      limit: z.number().int().min(1).optional(),
      cursor: z.string().nullish(),
    })
    .optional(),
});

const LookupRequest = z.object({ ids: z.array(z.string()).min(1) });

const DATE = z.iso.date();
const BOUND = z.union([DATE, z.iso.datetime({ offset: true })]);
const AvailabilityRequest = z.object({
  service_id: z.string().min(1),
  start_date: BOUND,
  end_date: BOUND,
  date_bounds_timezone: z.string().optional(),
  resource_id: z.string().optional(),
  party_size: z.number().int().min(1).max(100).default(1),
  location_id: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().optional(),
});

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o?: unknown }).o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw new ProtocolError(
    'cursor_expired',
    'The pagination cursor is not valid any more.',
    'Restart from the first page by omitting the cursor.',
  );
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function createUspRouter(options: UspRouterOptions): Hono {
  const { service } = options;
  const businessId = options.businessId ?? new URL(options.baseUrl).host;
  const maxRangeDays = options.maxRangeDays ?? 7;
  const consent = options.consent ?? 'action';
  if (options.auth && consent === 'action' && !options.continueUrl) {
    throw new Error(
      "createUspRouter: consent 'action' needs continueUrl (the page where the buyer confirms), " +
        "or set consent: 'commit' to take the platform's request as the buyer's approval.",
    );
  }
  // Moving a booking changes what the customer agreed to, so it is only offered when the platform
  // may decide that for them (commit) and the booking system can do it.
  const reschedule =
    consent === 'commit' && typeof service.provider.rescheduleBooking === 'function';
  const app = new Hono();

  /** Every service of every venue, with the context the mapping needs. */
  async function catalog(venueId?: string) {
    const all = await service.listVenues();
    const rows: Array<{ venue: Venue; offering: Offering; resources: Resource[] }> = [];
    for (const venue of all.filter((v) => !venueId || v.id === venueId)) {
      const [offerings, resources] = await Promise.all([
        service.listOfferings(venue.id),
        service.listResources(venue.id),
      ]);
      for (const offering of offerings) rows.push({ venue, offering, resources });
    }
    const toUsp = (row: (typeof rows)[number]) =>
      toService(row.offering, {
        businessId,
        multiVenue: all.length > 1,
        venue: row.venue,
        resources: row.resources,
        reschedule,
        ...(options.serviceDetails ? { details: options.serviceDetails(row.offering) } : {}),
      });
    return { rows, all, toUsp };
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  app.post(
    '/services/list',
    guard(async (c) => {
      const req = parse(ListRequest, await readBody(c));
      const { rows, toUsp } = await catalog(req.filters?.location_id);
      let services = rows.map((r) => toUsp(r));
      const f = req.filters;
      if (f?.type) services = services.filter((s) => s.type === f.type);
      if (f?.price) {
        // Services without a fixed amount have no price to compare, so a price filter excludes them.
        services = services.filter((s) => {
          const amount = 'amount' in s.pricing ? s.pricing.amount : undefined;
          return (
            amount !== undefined &&
            (f.price!.min === undefined || amount >= f.price!.min) &&
            (f.price!.max === undefined || amount <= f.price!.max)
          );
        });
      }
      const offset = decodeCursor(req.pagination?.cursor);
      const limit = Math.min(req.pagination?.limit ?? DEFAULT_PAGE, MAX_PAGE);
      const page = services.slice(offset, offset + limit);
      const hasMore = offset + limit < services.length;
      return c.json({
        usp: envelope(USP.catalog),
        services: page,
        pagination: { cursor: hasMore ? encodeCursor(offset + limit) : null, has_more: hasMore },
      });
    }),
  );

  app.post(
    '/services/lookup',
    guard(async (c) => {
      const req = parse(LookupRequest, await readBody(c));
      if (req.ids.length > MAX_LOOKUP_IDS) {
        throw new ProtocolError(
          'validation_error',
          `At most ${MAX_LOOKUP_IDS} ids may be looked up at once.`,
          'Split the ids into several requests.',
        );
      }
      const { rows, toUsp } = await catalog();
      const byId = new Map(rows.map((r) => [toUsp(r).id, r]));
      const seen = new Set<string>();
      const services: ReturnType<typeof toUsp>[] = [];
      const messages: UspMessage[] = [];
      req.ids.forEach((id, i) => {
        if (seen.has(id)) return; // duplicates are silently deduplicated
        seen.add(id);
        const row = byId.get(id);
        if (row) services.push(toUsp(row));
        else {
          messages.push(
            message(
              'warning',
              'service_unresolved',
              'This service id is not known to the business.',
              { path: `$.ids[${i}]` },
            ),
          );
        }
      });
      return c.json({
        usp: envelope(USP.catalog),
        services,
        ...(messages.length ? { messages } : {}),
      });
    }),
  );

  // Literal routes win over `/services/{service_id}`, including for the wrong method: a GET on
  // /services/list is a 405, not a lookup of a service called "list" (spec 3.13 item 11).
  const methodNotAllowed = (allow: string) => () =>
    problemResponse(405, 'This method is not allowed on this resource.', {
      headers: { allow },
    });
  app.all('/services/list', methodNotAllowed('POST'));
  app.all('/services/lookup', methodNotAllowed('POST'));
  app.get('/services/feed', () =>
    problemResponse(501, 'This business does not offer a service feed; use POST /services/list.'),
  );
  app.all('/services/feed', methodNotAllowed('GET'));

  app.get(
    '/services/:service_id',
    guard(async (c) => {
      const id = c.req.param('service_id');
      const { rows, toUsp } = await catalog();
      const row = rows.find((r) => toUsp(r).id === id);
      if (!row) {
        // An unknown id in the path is always a 404 (spec 3.12.3), never a 200 with a message.
        throw new ProtocolError(
          'service_not_found',
          'No service with this id.',
          'List the catalog with POST /services/list and use one of its ids.',
        );
      }
      return c.json({ usp: envelope(USP.catalog), service: toUsp(row) });
    }),
  );

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  app.post(
    '/availability/query',
    guard(async (c) => {
      const req = parse(AvailabilityRequest, await readBody(c));
      const venues = await service.listVenues();
      const target = parseServiceId(req.service_id, venues);
      const offering =
        target &&
        (await service.listOfferings(target.venueId)).find((o) => o.id === target.offeringId);
      if (!target || !offering) {
        // The id is in the body here, so this is a validation problem rather than a 404.
        throw new ProtocolError(
          'validation_error',
          'service_id: no service with this id.',
          'List the catalog with POST /services/list and use one of its ids.',
        );
      }
      const venue = venues.find((v) => v.id === target.venueId)!;
      const multiVenue = venues.length > 1;
      if (req.location_id && req.location_id !== venue.id) {
        return c.json({
          usp: envelope(USP.availability),
          service_id: req.service_id,
          applied_date_bounds_timezone: req.date_bounds_timezone ?? venue.timezone,
          business_timezone: venue.timezone,
          slots: [],
        });
      }

      const appliedZone = req.date_bounds_timezone ?? venue.timezone;
      if (!validZone(appliedZone)) {
        throw new ProtocolError('validation_error', 'date_bounds_timezone: not an IANA time zone.');
      }
      const isDate = (v: string) => DATE.safeParse(v).success;
      // A date-only bound is read on the applied zone's calendar; a date-time is already an instant.
      const from = isDate(req.start_date)
        ? time.zonedToInstant(req.start_date, '00:00', appliedZone)
        : new Date(req.start_date);
      const until = isDate(req.end_date)
        ? time.zonedToInstant(time.addDays(req.end_date, 1), '00:00', appliedZone)
        : new Date(req.end_date);
      if (until <= from) {
        throw new ProtocolError('validation_error', 'end_date: must be after start_date.');
      }
      // Slots are searched by the venue's own days; cover every venue day the range touches.
      const days = daysBetween(
        time.localDate(from, venue.timezone),
        time.localDate(new Date(until.getTime() - 1), venue.timezone),
      );
      if (days.length > maxRangeDays) {
        throw new ProtocolError(
          'range_too_wide',
          `The range covers more than ${maxRangeDays} days.`,
          `Query at most ${maxRangeDays} days at a time and page through the range.`,
        );
      }

      /** One search per day, then one per extra resource so every resource gets its own slot. */
      const searchDay = async (date: string): Promise<Slot[]> => {
        const base = {
          venue_id: venue.id,
          date,
          party_size: { total: req.party_size },
          offering_id: offering.id,
          limit: 50,
        };
        const first = await service.searchAvailability({
          ...base,
          ...(req.resource_id ? { tags: [req.resource_id] } : {}),
        });
        const slots = new Map(first.slots.map((s) => [s.slot_id, s]));
        if (req.resource_id) return [...slots.values()];
        const covered = new Set(first.slots.map((s) => s.resource?.label));
        const others = new Set(first.slots.flatMap((s) => s.also_available ?? []));
        for (const label of others) {
          if (covered.has(label)) continue;
          const extra = await service.searchAvailability({ ...base, tags: [label] });
          for (const s of extra.slots) if (s.resource?.label === label) slots.set(s.slot_id, s);
          covered.add(label);
        }
        return [...slots.values()];
      };

      const messages: UspMessage[] = [];
      const found = new Map<string, Slot>();
      let tooLarge = false;
      for (const date of days) {
        try {
          for (const slot of await searchDay(date)) found.set(slot.slot_id, slot);
        } catch (e) {
          // A party the venue cannot seat is a business outcome, not a protocol failure.
          if (e instanceof BookingError && e.code === 'party_size_unsupported') tooLarge = true;
          else throw e;
        }
      }
      if (tooLarge) {
        messages.push(
          message('warning', 'capacity_exceeded', 'The venue cannot take this party size online.', {
            severity: 'requires_buyer_review',
          }),
        );
      }

      const inRange = [...found.values()]
        .filter((s) => {
          const start = Date.parse(s.start);
          return start >= from.getTime() && start < until.getTime();
        })
        .sort(
          (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.slot_id.localeCompare(b.slot_id),
        );

      // Slots with a deposit due at confirmation cannot be booked through USP yet (that needs the
      // payment flow), so we do not offer them rather than let a platform hit a dead end.
      const bookable = inRange.filter((s) => s.deposit?.due !== 'at_confirmation');
      if (bookable.length < inRange.length) {
        messages.push(
          message(
            'info',
            'slots_omitted',
            `${inRange.length - bookable.length} slot(s) need an online deposit and are not offered here.`,
          ),
        );
      }

      const offset = decodeCursor(req.cursor);
      const limit = Math.min(req.limit ?? MAX_PAGE, MAX_PAGE);
      const page = bookable.slice(offset, offset + limit);
      const hasMore = offset + limit < bookable.length;
      const info = await service.getVenueInfo(venue.id);
      return c.json({
        usp: envelope(USP.availability),
        service_id: req.service_id,
        applied_date_bounds_timezone: appliedZone,
        business_timezone: venue.timezone,
        slots: page.map((s) => toTimeSlot(s, venue, multiVenue)),
        ...(info ? { opening_hours: openingHours(info) } : {}),
        ...(messages.length ? { messages } : {}),
        pagination: { cursor: hasMore ? encodeCursor(offset + limit) : null, has_more: hasMore },
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Wrong method / unknown path
  // -------------------------------------------------------------------------

  registerBookingRoutes(app, {
    service,
    mode: consent,
    ...(options.continueUrl ? { continueUrl: options.continueUrl } : {}),
    ...(options.bookingUrl ? { bookingUrl: options.bookingUrl } : {}),
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.businessAuth ? { businessAuth: options.businessAuth } : {}),
    state: options.state ?? new MemoryUspState(),
  });
  app.all('/availability/query', methodNotAllowed('POST'));
  app.all('/availability/holds', methodNotAllowed('POST'));
  app.all('/availability/holds/:hold_id', methodNotAllowed('DELETE'));
  app.all('/bookings', methodNotAllowed('POST'));
  app.all('/bookings/:booking_id', methodNotAllowed('GET, PUT'));
  app.all('/bookings/:booking_id/:action', methodNotAllowed('POST'));
  app.all('/services/:service_id', methodNotAllowed('GET'));
  app.all('*', () => problemResponse(404, 'No such USP resource.'));

  return app;
}
