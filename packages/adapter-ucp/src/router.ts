/**
 * UCP REST binding for `dev.ucp.lodging.booking` (paths from UCP main@b0e81ade
 * `docs/specification/lodging/booking/rest.md`):
 *
 *   POST /booking-sessions                 create  → 201
 *   GET  /booking-sessions/{id}            get     → 200
 *   PUT  /booking-sessions/{id}            update  → 200 (full replacement)
 *   POST /booking-sessions/{id}/complete   complete→ 200
 *   POST /booking-sessions/{id}/cancel     cancel  → 200
 *
 * plus the EXTENSION `GET /availability` and the extension JSON Schemas under `/schemas/`.
 *
 * Mount with `app.route('/ucp', createUcpRouter({ service, baseUrl }))`.
 */
import {
  BookingError,
  isBookingError,
  toErrorPayload,
  type Booking,
  type BookingService,
} from '@openbooking-sh/core';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { OB } from './constants';
import { availabilitySchema, bookingExtensionSchema } from './extension-schemas';
import {
  customerFrom,
  errorMessage,
  errorResponse,
  offerFor,
  responseMeta,
  toUcpSession,
} from './mapping';

export interface UcpRouterOptions {
  service: BookingService;
  /** Public origin, e.g. `https://bistro.example.com`. Used for schema `$id`s. */
  baseUrl: string;
  /** Mount path of this router (for schema URLs). Default `/ucp`. */
  ucpPath?: string;
}

const HTTP_STATUS: Partial<Record<string, ContentfulStatusCode>> = {
  validation_error: 400,
  not_found: 404,
  idempotency_conflict: 409,
  provider_error: 503,
};

export function createUcpRouter(options: UcpRouterOptions): Hono {
  const { service } = options;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}${options.ucpPath ?? '/ucp'}`;
  const app = new Hono();

  // Echo Request-Id (UCP header) for correlation.
  app.use('*', async (c, next) => {
    await next();
    const rid = c.req.header('Request-Id');
    if (rid) c.header('Request-Id', rid);
  });

  const venueOf = async (id: string) => {
    const venue = (await service.listVenues()).find((v) => v.id === id);
    if (!venue) throw new BookingError('not_found', `Unknown property ${id}`);
    return venue;
  };
  const session = async (b: Booking, extra: ReturnType<typeof errorMessage>[] = []) =>
    toUcpSession(b, await venueOf(b.venue_id), extra);

  /** Protocol errors → HTTP 4xx/5xx; business outcomes → 200 (UCP: messages[]). */
  const fail = (c: Context, e: unknown) => {
    const payload = toErrorPayload(e);
    return c.json(errorResponse(payload), HTTP_STATUS[payload.code] ?? 200);
  };

  /**
   * For operations on an existing session, business failures return the session itself with the
   * error in `messages[]` (status unchanged), as UCP prescribes for business outcomes.
   */
  const failOnSession = async (c: Context, id: string, e: unknown) => {
    const payload = toErrorPayload(e);
    if (HTTP_STATUS[payload.code] || !isBookingError(e)) return fail(c, e);
    try {
      const current = await service.getBooking(id);
      return c.json(await session(current, [errorMessage(payload)]), 200);
    } catch {
      return fail(c, e);
    }
  };

  const idempotencyKey = (c: Context) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) {
      throw new BookingError('validation_error', 'Missing Idempotency-Key header.', {
        suggested_next_action:
          'Send a UUID in the Idempotency-Key header; reuse it only when retrying the same request.',
      });
    }
    return key;
  };

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new BookingError('validation_error', 'Request body must be a JSON object.');
  };

  // -------------------------------------------------------------------------
  // Booking sessions
  // -------------------------------------------------------------------------

  app.post('/booking-sessions', async (c) => {
    try {
      const key = idempotencyKey(c);
      const req = await body(c);
      const stays = Array.isArray(req.stays) ? (req.stays as Array<Record<string, unknown>>) : [];
      if (stays.length !== 1 || typeof stays[0]?.id !== 'string') {
        throw new BookingError(
          'validation_error',
          'Exactly one stay with an `id` (a slot id from GET /availability) is required.',
          {
            suggested_next_action:
              'Call GET /availability, then send stays: [{ "id": "<offer id>" }].',
          },
        );
      }
      const customer = customerFrom(req.booker);
      const booking = await service.hold({
        slot_id: stays[0].id,
        idempotency_key: key,
        ...(customer ? { customer: customer as never } : {}),
      });
      const property = req.property as { id?: unknown } | undefined;
      if (property?.id !== undefined && property.id !== booking.venue_id) {
        // Release the hold we just made; the request was inconsistent.
        await service.cancel({
          booking_id: booking.booking_id,
          idempotency_key: `${key}:rollback`,
        });
        throw new BookingError(
          'validation_error',
          `property.id does not match the stay (expected ${booking.venue_id}).`,
        );
      }
      return c.json(await session(booking), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/booking-sessions/:id', async (c) => {
    try {
      return c.json(await session(await service.getBooking(c.req.param('id'))), 200);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.put('/booking-sessions/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const key = idempotencyKey(c);
      const req = await body(c);
      const current = await service.getBooking(id);
      const stays = Array.isArray(req.stays) ? (req.stays as Array<Record<string, unknown>>) : [];
      if (stays.length && (stays.length !== 1 || stays[0]?.id !== current.slot.slot_id)) {
        throw new BookingError('operation_not_supported', 'Changing stays is not supported.', {
          suggested_next_action: 'Cancel this session and create a new one for a different slot.',
        });
      }
      const customer = customerFrom(req.booker);
      if (!customer) return c.json(await session(current), 200);
      const updated = await service.update({
        booking_id: id,
        idempotency_key: key,
        customer: customer as never,
      });
      return c.json(await session(updated), 200);
    } catch (e) {
      return failOnSession(c, id, e);
    }
  });

  app.post('/booking-sessions/:id/complete', async (c) => {
    const id = c.req.param('id');
    try {
      const key = idempotencyKey(c);
      const req = await body(c);
      const booking = await service.confirm({
        booking_id: id,
        idempotency_key: key,
        // EXTENSION (sh.openbooking.booking): explicit consent flag, never inferred.
        user_confirmed: req.user_confirmed === true,
        // EXTENSION: deposit token until proper UCP payment-handler integration lands.
        ...(typeof req.payment_token === 'string' ? { payment_token: req.payment_token } : {}),
      });
      return c.json(await session(booking), 200);
    } catch (e) {
      return failOnSession(c, id, e);
    }
  });

  app.post('/booking-sessions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    try {
      const key = idempotencyKey(c);
      const req = await body(c);
      const { booking } = await service.cancel({
        booking_id: id,
        idempotency_key: key,
        ...(req.user_confirmed === true ? { user_confirmed: true } : {}),
        ...(typeof req.reason === 'string' ? { reason: req.reason } : {}),
      });
      return c.json(await session(booking), 200);
    } catch (e) {
      return failOnSession(c, id, e);
    }
  });

  // -------------------------------------------------------------------------
  // EXTENSION: availability
  // -------------------------------------------------------------------------

  app.get('/availability', async (c) => {
    try {
      const q = c.req.query();
      const party = Number(q.party_size);
      const { venue, slots } = await service.searchAvailability({
        date: q.date ?? '',
        party_size: { total: Number.isFinite(party) ? party : 0 },
        ...(q.venue_id ? { venue_id: q.venue_id } : {}),
        ...(q.time_from ? { time_from: q.time_from } : {}),
        ...(q.time_to ? { time_to: q.time_to } : {}),
        ...(q.offering_id ? { offering_id: q.offering_id } : {}),
        ...(q.tags ? { tags: q.tags.split(',').filter(Boolean) } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      });
      return c.json({
        ucp: responseMeta([OB.availability]),
        property: {
          id: venue.id,
          name: venue.name,
          ...(venue.address ? { address: venue.address } : {}),
        },
        offers: slots.map((s) => offerFor(s, venue)),
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  // -------------------------------------------------------------------------
  // Extension schemas
  // -------------------------------------------------------------------------

  app.get(`/schemas/${OB.booking}.json`, (c) =>
    c.json(bookingExtensionSchema(`${endpoint}/schemas/${OB.booking}.json`)),
  );
  app.get(`/schemas/${OB.availability}.json`, (c) =>
    c.json(availabilitySchema(`${endpoint}/schemas/${OB.availability}.json`)),
  );

  return app;
}
