/**
 * USP holds and bookings (spec sections 4.2 and 5.3):
 *
 *   POST   /availability/holds                  reserve a slot (201)
 *   DELETE /availability/holds/{hold_id}        release it
 *   POST   /bookings                            create a booking, from a hold or a slot (201)
 *   GET    /bookings/{id}                       read one
 *   PUT    /bookings/{id}                       change buyer details / notes
 *   POST   /bookings/{id}/cancel                cancel
 *   POST   /bookings/{id}/reschedule            move to another slot
 *   POST   /bookings/{id}/confirm               business-only; a no-op while every booking is auto
 *
 * Consent. USP has no "the buyer approved" flag, and forbids a platform from claiming acceptance
 * the business cannot verify. So each business picks how a booking becomes real:
 *  - `action` (default): creating a booking holds the slot and returns `requires_action` with a
 *    link to the business's page. The buyer presses the button there; only then is it confirmed.
 *  - `commit`: creating the booking confirms it, trusting that the platform asked its user first.
 *
 * Every operation here needs an authenticated platform and, for an existing hold or booking, the
 * same platform that made it: anyone else is told it does not exist.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  BookingError,
  evaluateBookingCancellation,
  formatMoney,
  time,
  type Booking,
  type BookingService,
} from '@openbooking-sh/core';
import type { Context, Hono } from 'hono';
import * as z from 'zod';
import type { UspAuthenticator, UspBusinessAuth, UspIssuedCredential, UspPrincipal } from './auth';
import {
  bookingIdOfHold,
  toBooking,
  toHold,
  type BookingContext,
  type ConsentMode,
} from './booking-mapping';
import { OB_NEXT_ACTION, USP } from './constants';
import { negotiate } from './negotiation';
import { bodyText, guard, jsonObject, parse } from './http';
import { serviceId } from './mapping';
import { businessOutcome, envelope, message, ProtocolError, type UspMessage } from './protocol';
import type { UspStateStore } from './state';

export interface BookingRoutesOptions {
  service: BookingService;
  mode: ConsentMode;
  continueUrl?: (b: Booking) => string;
  bookingUrl?: (b: Booking) => string | undefined;
  auth?: UspAuthenticator;
  businessAuth?: UspBusinessAuth;
  state: UspStateStore;
}

const BUYER = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.email(),
  phone_number: z.string().min(1).optional(),
});

const HoldRequest = z.object({
  slot_id: z.string().min(1),
  service_id: z.string().min(1),
  spots: z.number().int().min(1).optional(),
});

const CreateRequest = z.object({
  service_id: z.string().min(1),
  slot_id: z.string().min(1),
  hold_id: z.string().min(1).optional(),
  buyer: BUYER,
  recipient: z.unknown().optional(),
  party_size: z.number().int().min(1).optional(),
  resource_id: z.string().optional(),
  notes: z.string().max(500).optional(),
  delivery_address: z.unknown().optional(),
  post_payment_return_request: z.unknown().optional(),
});

const UpdateRequest = z.object({
  buyer: BUYER.partial().extend({ consent: z.unknown().optional() }).optional(),
  recipient: z.unknown().optional(),
  notes: z.string().max(500).optional(),
});

const CancelRequest = z.object({ reason: z.string().max(500).optional() });
const RescheduleRequest = z.object({
  slot_id: z.string().min(1),
  hold_id: z.string().min(1).optional(),
});

/** Stable JSON for fingerprinting a request body. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const digest = (s: string) => createHash('sha256').update(s).digest('base64url').slice(0, 22);

/** A path parameter (always present on the routes that use it). */
const param = (c: Context, name: string) => c.req.param(name) ?? '';

export function registerBookingRoutes(app: Hono, o: BookingRoutesOptions): void {
  const { service, mode, state } = o;

  const notFound = () =>
    new ProtocolError(
      'booking_not_found',
      'No booking or hold with this id.',
      'Check the id; only the platform that created a hold or booking can use it.',
    );

  /** Authenticate, then run. Without an authenticator every privileged operation is refused. */
  const privileged = (
    needs: (typeof USP)['availability' | 'bookings'],
    handler: (c: Context, p: UspPrincipal, text: string) => Promise<Response>,
  ) =>
    guard(async (c) => {
      if (!o.auth) {
        throw new ProtocolError(
          'authentication_required',
          'This business has not enabled authenticated platforms, so it cannot take holds or bookings here.',
          'Use only the public catalog and availability operations, or book on the business page.',
        );
      }
      const text = await bodyText(c);
      const principal = await o.auth.authenticate(c.req.raw, text);
      if (principal.platform) {
        // Use only what both sides have (spec 8.3), and refuse a platform that is newer than us (8.4).
        const n = negotiate(principal.platform);
        if (n.kind === 'version_unsupported') {
          throw new ProtocolError(
            'version_unsupported',
            'The platform speaks a newer USP version than this business supports.',
            `Use USP version ${n.latest} or earlier.`,
            undefined,
            {
              messages: [
                message(
                  'info',
                  'latest_supported_version',
                  `The latest supported version is ${n.latest}.`,
                ),
              ],
            },
          );
        }
        if (n.kind !== 'ok' || !(needs in n.capabilities)) {
          return c.json({
            usp: envelope(),
            messages: [
              message(
                'error',
                'capabilities_incompatible',
                'Your platform profile and this business share no capability that covers this operation.',
                {
                  // The spec's prose gives this `unrecoverable`, but its own message schema does
                  // not allow that value, so no severity is sent (it is optional).
                  [OB_NEXT_ACTION]:
                    'Add the capability to your platform profile, or tell the operator it is a configuration mismatch.',
                },
              ),
            ],
          });
        }
      }
      return handler(c, principal, text);
    });

  /** The key for one step of an operation, scoped to the caller so keys never collide or leak. */
  const stepKey = (p: UspPrincipal, key: string, step: string) =>
    `usp-${digest(`${p.id}\n${key}`)}:${step}`;
  const keyOf = (c: Context) => c.req.header('idempotency-key') ?? randomUUID();

  /** The same key with a different request is a conflict (spec 9.1.1). */
  const checkKey = async (p: UspPrincipal, c: Context, op: string, request: unknown) => {
    const supplied = c.req.header('idempotency-key');
    if (!supplied) return;
    const ok = await state.checkKey(stepKey(p, supplied, op), digest(canonical(request)));
    if (!ok) {
      throw new ProtocolError(
        'idempotency_conflict',
        'This Idempotency-Key was already used for a different request.',
        'Use a new key for a new action; reuse a key only to retry the exact same request.',
      );
    }
  };

  const context = async (b: Booking): Promise<BookingContext> => {
    const venues = await service.listVenues();
    const venue = venues.find((v) => v.id === b.venue_id) ?? venues[0]!;
    return {
      venue,
      multiVenue: venues.length > 1,
      mode,
      now: service.clock.now(),
      ...(o.continueUrl ? { continueUrl: o.continueUrl } : {}),
      ...(o.bookingUrl ? { bookingUrl: o.bookingUrl } : {}),
    };
  };

  /**
   * May this caller act on this hold or booking? With a credential, only if its scope names it
   * (spec 10.1.6 step 3). Without one, only the platform that created it: an equivalent
   * per-resource check, since a platform's identity alone is not authority over every booking.
   */
  const mayUse = async (p: UspPrincipal, id: string): Promise<boolean> =>
    p.credential
      ? p.credential.scope.includes(`booking:${id}`)
      : (await state.ownerOf(id)) === p.id;

  /** A credential for a hold or booking just made for this caller (returned only on creation). */
  const issue = (p: UspPrincipal, b: Booking) =>
    o.auth?.issueCredential?.(p, { id: b.booking_id, endsAt: new Date(b.slot.end) });

  /** A booking this platform may use, or "not found" (never reveal that someone else's exists). */
  const owned = async (p: UspPrincipal, id: string, asBooking: boolean): Promise<Booking> => {
    if (!(await mayUse(p, id))) throw notFound();
    if (asBooking && !(await state.isBooking(id))) throw notFound();
    try {
      return await service.getBooking(id);
    } catch (e) {
      if (e instanceof BookingError && e.code === 'not_found') throw notFound();
      throw e;
    }
  };

  const bookingResponse = async (
    c: Context,
    b: Booking,
    messages: UspMessage[] = [],
    status: 200 | 201 = 200,
    credential?: UspIssuedCredential,
  ) => {
    const view = toBooking(b, await context(b));
    if (!view) throw notFound();
    return c.json(
      {
        usp: envelope(USP.bookings),
        booking: view,
        ...(credential ? { booking_scoped_credential: credential } : {}),
        ...(messages.length ? { messages } : {}),
      },
      status,
    );
  };

  /** A business outcome with no booking to show (a taken slot, an expired hold). */
  const outcome = (c: Context, capability: 'availability' | 'bookings', messages: UspMessage[]) =>
    c.json({ usp: envelope(USP[capability]), messages });

  /** Release a hold we made ourselves (a failed create must not leave a reservation behind). */
  const rollback = async (p: UspPrincipal, key: string, b: Booking) => {
    await service
      .cancel({
        booking_id: b.booking_id,
        idempotency_key: stepKey(p, key, 'rollback'),
        reason: 'Released: the booking could not be completed',
      })
      .catch(() => undefined);
  };

  /** Is this slot still bookable? Decides `hold_expired` versus `slot_unavailable`. */
  const slotStillFree = async (b: Booking): Promise<boolean> => {
    const venues = await service.listVenues();
    const venue = venues.find((v) => v.id === b.venue_id);
    if (!venue) return false;
    try {
      const { slots } = await service.searchAvailability({
        venue_id: venue.id,
        date: time.localDate(new Date(b.slot.start), venue.timezone),
        party_size: { total: b.slot.party_size.total },
        offering_id: b.slot.offering.id,
        ...(b.slot.resource?.id ? { tags: [b.slot.resource.id] } : {}),
        limit: 50,
      });
      return slots.some((s) => s.slot_id === b.slot.slot_id);
    } catch {
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // Holds
  // -------------------------------------------------------------------------

  app.post(
    '/availability/holds',
    privileged(USP.availability, async (c, p, text) => {
      const req = parse(HoldRequest, jsonObject(text));
      await checkKey(p, c, 'hold', req);
      const key = keyOf(c);

      let booking: Booking;
      try {
        booking = await service.hold({
          slot_id: req.slot_id,
          idempotency_key: stepKey(p, key, 'hold'),
        });
      } catch (e) {
        const m = businessOutcome(e);
        if (m) return outcome(c, 'availability', [m]);
        throw e;
      }
      if (!(await state.claim(booking.booking_id, p.id))) throw notFound();

      const ctx = await context(booking);
      if (serviceId(ctx.venue.id, booking.slot.offering.id, ctx.multiVenue) !== req.service_id) {
        await rollback(p, key, booking);
        throw new ProtocolError('validation_error', 'slot_id: this slot is not for service_id.');
      }
      if ((req.spots ?? 1) !== booking.slot.party_size.total) {
        await rollback(p, key, booking);
        return outcome(c, 'availability', [
          message(
            'error',
            'capacity_exceeded',
            `This slot is for ${booking.slot.party_size.total} guest(s); spots does not match.`,
            { severity: 'recoverable' },
          ),
        ]);
      }
      const credential = await issue(p, booking);
      return c.json(
        {
          usp: envelope(USP.availability),
          hold: toHold(booking, ctx),
          ...(credential ? { booking_scoped_credential: credential } : {}),
        },
        201,
      );
    }),
  );

  app.delete(
    '/availability/holds/:hold_id',
    privileged(USP.availability, async (c, p) => {
      const id = bookingIdOfHold(param(c, 'hold_id'));
      if (!id) throw notFound();
      let booking = await owned(p, id, false);
      if (booking.status === 'held') {
        // Releasing needs no consent, and a stable key makes releasing twice harmless.
        const key = c.req.header('idempotency-key') ?? `release:${id}`;
        booking = (
          await service.cancel({
            booking_id: id,
            idempotency_key: stepKey(p, key, 'release'),
            reason: 'Released by the platform',
          })
        ).booking;
      }
      return c.json({
        usp: envelope(USP.availability),
        hold: toHold(booking, await context(booking)),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Bookings
  // -------------------------------------------------------------------------

  app.post(
    '/bookings',
    privileged(USP.bookings, async (c, p, text) => {
      const req = parse(CreateRequest, jsonObject(text));
      await checkKey(p, c, 'create', req);
      const key = keyOf(c);
      const warnings: UspMessage[] = [];
      if (req.recipient !== undefined) {
        warnings.push(
          message(
            'warning',
            'recipient_not_stored',
            'This business does not store a separate recipient; the booking is for the buyer.',
          ),
        );
      }

      let booking: Booking;
      let created = false;

      if (req.hold_id) {
        const id = bookingIdOfHold(req.hold_id);
        // An unknown hold id (or someone else's) is a validation problem, not a 404 (spec 4.2.1).
        if (!id || !(await mayUse(p, id))) {
          throw new ProtocolError('validation_error', 'hold_id: no such hold.');
        }
        try {
          booking = await service.getBooking(id);
        } catch {
          throw new ProtocolError('validation_error', 'hold_id: no such hold.');
        }
        if (booking.status === 'confirmed' && (await state.isBooking(id))) {
          // The hold already became this booking: replaying returns it (spec 4.2.1).
          return bookingResponse(c, booking, warnings, 201, await issue(p, booking));
        }
        if (booking.status === 'expired' || booking.status === 'cancelled') {
          const free = await slotStillFree(booking);
          return outcome(c, 'bookings', [
            message(
              'error',
              free ? 'hold_expired' : 'slot_unavailable',
              free
                ? 'The hold ran out. The time is still free: hold it again and create the booking promptly.'
                : 'The hold ran out and the time has since been taken.',
              { severity: 'recoverable' },
            ),
          ]);
        }
      } else {
        try {
          booking = await service.hold({
            slot_id: req.slot_id,
            idempotency_key: stepKey(p, key, 'hold'),
          });
        } catch (e) {
          const m = businessOutcome(e);
          if (m) return outcome(c, 'bookings', [m]);
          throw e;
        }
        created = true;
        if (!(await state.claim(booking.booking_id, p.id))) throw notFound();
      }

      const ctx = await context(booking);
      const fail = async (e: unknown) => {
        if (created) await rollback(p, key, booking);
        const m = businessOutcome(e);
        if (m) return outcome(c, 'bookings', [m]);
        throw e;
      };

      if (
        booking.slot.slot_id !== req.slot_id ||
        serviceId(ctx.venue.id, booking.slot.offering.id, ctx.multiVenue) !== req.service_id
      ) {
        return fail(new ProtocolError('validation_error', 'slot_id: does not match the hold.'));
      }
      if ((req.party_size ?? 1) > booking.slot.party_size.total) {
        // The hold stays active so the platform can retry with a party that fits (spec 4.2.1).
        if (created) await rollback(p, key, booking);
        return outcome(c, 'bookings', [
          message(
            'error',
            'capacity_exceeded',
            `This slot is for ${booking.slot.party_size.total} guest(s); party_size is larger.`,
            { severity: 'recoverable' },
          ),
        ]);
      }
      if (booking.slot.deposit?.due === 'at_confirmation') {
        // Deposits need the payment flow, which is not offered here; fail closed.
        return fail(
          new BookingError(
            'slot_unavailable',
            'This time needs an online deposit, which cannot be taken through USP here.',
            {
              suggested_next_action: 'Offer another time, or send the buyer to the business page.',
            },
          ),
        );
      }

      const customer = {
        first_name: req.buyer.first_name,
        last_name: req.buyer.last_name,
        email: req.buyer.email,
        ...(req.buyer.phone_number ? { phone_number: req.buyer.phone_number } : {}),
      };
      try {
        booking = await service.update({
          booking_id: booking.booking_id,
          idempotency_key: stepKey(p, key, 'buyer'),
          customer,
          ...(req.notes ? { notes: req.notes } : {}),
        });
      } catch (e) {
        // Without update support the buyer can still ride along on the confirm (commit only): the
        // confirm page needs the buyer stored first.
        const unsupported = e instanceof BookingError && e.code === 'operation_not_supported';
        if (!(unsupported && mode === 'commit')) return fail(e);
      }

      if (mode === 'commit') {
        try {
          booking = await service.confirm({
            booking_id: booking.booking_id,
            idempotency_key: stepKey(p, key, 'confirm'),
            // Commit mode: this business takes the platform's request as the buyer's approval.
            user_confirmed: true,
            customer,
          });
        } catch (e) {
          return fail(e);
        }
      }
      await state.markBooking(booking.booking_id);
      return bookingResponse(c, booking, warnings, 201, await issue(p, booking));
    }),
  );

  app.get(
    '/bookings/:booking_id',
    privileged(USP.bookings, async (c, p) =>
      bookingResponse(c, await owned(p, param(c, 'booking_id'), true)),
    ),
  );

  app.put(
    '/bookings/:booking_id',
    privileged(USP.bookings, async (c, p, text) => {
      const req = parse(UpdateRequest, jsonObject(text));
      await checkKey(p, c, 'update', req);
      const booking = await owned(p, param(c, 'booking_id'), true);
      const messages: UspMessage[] = [];
      if (req.recipient !== undefined) {
        messages.push(
          message('warning', 'recipient_not_stored', 'This business does not store a recipient.'),
        );
      }
      if (booking.status === 'cancelled' || booking.status === 'expired') {
        messages.push(
          message('error', 'invalid_transition', 'A canceled booking can no longer be changed.', {
            severity: 'requires_buyer_review',
          }),
        );
        return bookingResponse(c, booking, messages);
      }
      const buyer = req.buyer;
      const current = booking.customer;
      if (!buyer && req.notes === undefined) return bookingResponse(c, booking, messages);
      try {
        const updated = await service.update({
          booking_id: booking.booking_id,
          idempotency_key: stepKey(p, keyOf(c), 'update'),
          ...(buyer && current
            ? {
                customer: {
                  first_name: buyer.first_name ?? current.first_name,
                  last_name: buyer.last_name ?? current.last_name,
                  ...((buyer.email ?? current.email)
                    ? { email: (buyer.email ?? current.email)! }
                    : {}),
                  ...((buyer.phone_number ?? current.phone_number)
                    ? { phone_number: (buyer.phone_number ?? current.phone_number)! }
                    : {}),
                },
              }
            : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
        });
        return bookingResponse(c, updated, messages);
      } catch (e) {
        const m = businessOutcome(e);
        if (!m) throw e;
        return bookingResponse(c, booking, [...messages, m]);
      }
    }),
  );

  app.post(
    '/bookings/:booking_id/cancel',
    privileged(USP.bookings, async (c, p, text) => {
      const req = parse(CancelRequest, jsonObject(text));
      await checkKey(p, c, 'cancel', req);
      const booking = await owned(p, param(c, 'booking_id'), true);
      if (booking.status === 'cancelled' || booking.status === 'expired') {
        return bookingResponse(c, booking, [
          message('error', 'invalid_transition', 'This booking is already canceled.', {
            severity: 'requires_buyer_review',
          }),
        ]);
      }
      if (booking.status === 'confirmed') {
        const terms = evaluateBookingCancellation(booking, service.clock.now());
        if (!terms.allowed) {
          return bookingResponse(c, booking, [
            message(
              'error',
              'cancellation_not_allowed',
              'The booking has already started and can no longer be canceled online.',
              { severity: 'requires_buyer_review' },
            ),
          ]);
        }
        if (!terms.free && mode === 'action') {
          // A fee needs the customer's own approval, which they give on their booking page.
          const link = o.bookingUrl?.(booking);
          return bookingResponse(c, booking, [
            message(
              'error',
              'cancellation_not_allowed',
              `Cancelling now costs ${terms.fee ? formatMoney(terms.fee) : 'a fee'}. The customer must approve that and cancel on their booking page${link ? `: ${link}` : '.'}`,
              { severity: 'requires_buyer_review' },
            ),
          ]);
        }
      }
      try {
        const { booking: cancelled } = await service.cancel({
          booking_id: booking.booking_id,
          idempotency_key: stepKey(p, keyOf(c), 'cancel'),
          // Free cancellations, and every cancellation in commit mode, are the platform's call.
          user_confirmed: true,
          ...(req.reason ? { reason: req.reason } : {}),
        });
        return bookingResponse(c, cancelled);
      } catch (e) {
        const m = businessOutcome(e);
        if (!m) throw e;
        return bookingResponse(c, booking, [m]);
      }
    }),
  );

  app.post(
    '/bookings/:booking_id/reschedule',
    privileged(USP.bookings, async (c, p, text) => {
      const req = parse(RescheduleRequest, jsonObject(text));
      await checkKey(p, c, 'reschedule', req);
      if (req.hold_id) {
        throw new ProtocolError('validation_error', 'hold_id: not supported when rescheduling.');
      }
      const booking = await owned(p, param(c, 'booking_id'), true);
      const supported = typeof service.provider.rescheduleBooking === 'function';
      if (mode === 'action' || !supported) {
        // Moving a booking changes the time, price and terms the customer agreed to, so in
        // `action` mode it is theirs to approve, and there is no page for that yet.
        return bookingResponse(c, booking, [
          message(
            'error',
            'reschedule_not_allowed',
            supported
              ? 'Moving a booking needs the customer. They can cancel on their booking page and book a new time, or contact the business.'
              : 'This business does not move bookings online. Cancel it and book a new time instead.',
            { severity: 'requires_buyer_review' },
          ),
        ]);
      }
      try {
        const moved = await service.reschedule({
          booking_id: booking.booking_id,
          slot_id: req.slot_id,
          idempotency_key: stepKey(p, keyOf(c), 'reschedule'),
          user_confirmed: true,
        });
        return bookingResponse(c, moved);
      } catch (e) {
        const m = businessOutcome(e);
        if (!m) throw e;
        return bookingResponse(c, booking, [m]);
      }
    }),
  );

  /**
   * Business-only (spec 5.3.4). Every booking here confirms itself or waits for its buyer, so the
   * only valid use is a no-op on a confirmed booking; anything else is `invalid_transition`.
   */
  app.post(
    '/bookings/:booking_id/confirm',
    guard(async (c) => {
      if (!o.businessAuth || !(await o.businessAuth(c.req.raw))) {
        throw new ProtocolError(
          'authentication_required',
          'Only the business can use this operation; a platform credential is not accepted.',
        );
      }
      const id = param(c, 'booking_id');
      let booking: Booking;
      try {
        booking = await service.getBooking(id);
      } catch {
        throw notFound();
      }
      if (!(await state.isBooking(id))) throw notFound();
      if (booking.status === 'confirmed') return bookingResponse(c, booking);
      return bookingResponse(c, booking, [
        message(
          'error',
          'invalid_transition',
          'This booking is not waiting for the business to confirm it; the buyer confirms it.',
          { severity: 'requires_buyer_review' },
        ),
      ]);
    }),
  );
}
