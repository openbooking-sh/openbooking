import { randomUUID } from 'node:crypto';
import {
  BookingError,
  time,
  type AvailabilityQuery,
  type Booking,
  type BookingProvider,
  type CancelBookingRequest,
  type CancellationPolicy,
  type ConfirmHoldRequest,
  type CreateHoldRequest,
  type ProviderContext,
  type Slot,
  type UpdateBookingRequest,
  type Venue,
} from '@openbooking/core';
import { CalApiError, CalClient, type CalClientOptions, type CalEventType } from './client';
import { MemoryCalcomStore, type CalcomRecord, type CalcomStore } from './store';

export interface CalcomCancellationRule {
  refundability?: CancellationPolicy['refundability'];
  /** Free cancellation until this many hours before start. Default 24. null = never free. */
  free_until_hours_before?: number | null;
  /** Shown to customers; Cal.com itself does not charge these. */
  late_fee?: { amount: number; currency: string } | null;
  no_show_fee?: { amount: number; currency: string } | null;
}

export interface CalcomProviderOptions extends CalClientOptions {
  /** The business as agents should see it. Cal.com has no venue concept. */
  venue: Venue;
  /** Only expose these event types (ids). Default: all visible event types of the account. */
  eventTypeIds?: number[];
  /** Cancellation terms shown to agents (Cal.com does not expose them via the API). */
  cancellation?: CalcomCancellationRule;
  /**
   * Cal.com event-type `price` unit. Cal.com stores prices in the smallest currency unit, which is
   * the default here; set to 'major' if your instance returns whole units.
   */
  priceUnit?: 'minor' | 'major';
  /** Where holds and booking mappings live. Default in-memory (lost on restart). */
  store?: CalcomStore;
  /** Re-check confirmed bookings with Cal.com when read (catches cancellations made in Cal.com). */
  refreshOnRead?: boolean;
}

interface SlotKey {
  e: number; // event type id
  s: string; // start, UTC ISO
}

/**
 * OpenBooking provider for Cal.com (hosted) and Cal.diy (self-hosted, API v2).
 *
 * Mapping:
 *  - Cal.com event type → offering (one attendee per booking; party_size must be 1)
 *  - Cal.com slot       → OpenBooking slot (slot_id encodes event type + start)
 *  - hold               → Cal.com slot reservation (`POST /v2/slots/reservations`) for the hold
 *                         TTL, plus a local hold record (Cal.com has no "held booking")
 *  - confirm            → `POST /v2/bookings` (attendee email required by Cal.com)
 *  - cancel             → delete reservation (hold) or `POST /v2/bookings/{uid}/cancel`
 *
 * Deposits/payments are not handled: Cal.com charges paid event types through its own Stripe
 * app, which the public API does not drive. Event types requiring host confirmation return
 * Cal.com status `pending`; those are reported as confirmed with a note.
 */
export class CalcomBookingProvider implements BookingProvider {
  readonly info: { name: string; description?: string };
  readonly #cal: CalClient;
  readonly #opts: CalcomProviderOptions;
  readonly #store: CalcomStore;
  #eventTypes: { at: number; list: CalEventType[] } | null = null;
  readonly #inFlight = new Set<string>();

  constructor(options: CalcomProviderOptions) {
    this.#opts = options;
    this.#cal = new CalClient(options);
    this.#store = options.store ?? new MemoryCalcomStore();
    this.info = {
      name: options.venue.name,
      ...(options.venue.description ? { description: options.venue.description } : {}),
    };
  }

  async listVenues(): Promise<Venue[]> {
    return [this.#opts.venue];
  }

  async searchAvailability(
    query: AvailabilityQuery & { venue_id: string },
    _ctx: ProviderContext,
  ): Promise<Slot[]> {
    if (query.party_size.total !== 1) {
      throw new BookingError(
        'party_size_unsupported',
        'Appointments here are booked for one person at a time.',
        {
          suggested_next_action: 'Book one appointment per person, each with party_size 1.',
        },
      );
    }
    const tz = this.#opts.venue.timezone;
    const types = (await this.#eventTypesList()).filter(
      (t) => !query.offering_id || String(t.id) === query.offering_id,
    );
    if (query.offering_id && !types.length) {
      const all = await this.#eventTypesList();
      throw new BookingError('not_found', `Unknown offering_id "${query.offering_id}".`, {
        suggested_next_action: `Use one of: ${all.map((t) => `${t.id} (${t.title})`).join(', ')}, or omit offering_id.`,
      });
    }

    const slots: Slot[] = [];
    for (const type of types) {
      // Ask for a UTC window around the local date, then keep slots that fall on it locally.
      const byDate = await this.#call(() =>
        this.#cal.getSlots({
          eventTypeId: type.id,
          start: time.addDays(query.date, -1),
          end: time.addDays(query.date, 1),
          timeZone: tz,
        }),
      );
      for (const s of Object.values(byDate ?? {}).flat()) {
        const start = new Date(s.start);
        if (time.localDate(start, tz) !== query.date) continue;
        const local = time.localTime(start, tz);
        if (query.time_from && local < query.time_from) continue;
        if (query.time_to && local > query.time_to) continue;
        slots.push(this.#slot(type, start, s.end ? new Date(s.end) : undefined));
      }
    }
    return slots.sort((a, b) => (a.start < b.start ? -1 : 1));
  }

  async createHold(req: CreateHoldRequest, ctx: ProviderContext): Promise<Booking> {
    const key = decodeSlotId(req.slot_id);
    const type = (await this.#eventTypesList()).find((t) => t.id === key.e);
    if (!type) throw invalidSlot();
    const start = new Date(key.s);
    if (start.getTime() <= ctx.now.getTime()) {
      throw new BookingError('slot_unavailable', 'This time has already passed.');
    }

    // All holds share the business's API key, and Cal.com may let the same key reserve a slot
    // twice. Guard locally: one active hold/booking per slot, locked while the reservation call
    // is in flight (set synchronously before any await).
    const slotKey = `${key.e}|${start.toISOString()}`;
    if (this.#inFlight.has(slotKey))
      throw new BookingError('slot_unavailable', 'That time was just taken.');
    this.#inFlight.add(slotKey);
    let reservation;
    try {
      const taken = (await this.#store.list()).some(
        (r) =>
          r.eventTypeId === key.e &&
          new Date(r.booking.slot.start).getTime() === start.getTime() &&
          (r.booking.status === 'confirmed' ||
            (r.booking.status === 'held' &&
              !!r.booking.expires_at &&
              new Date(r.booking.expires_at).getTime() > ctx.now.getTime())),
      );
      if (taken) throw new BookingError('slot_unavailable', 'That time was just taken.');
      const minutes = Math.max(
        1,
        Math.ceil((req.expires_at.getTime() - ctx.now.getTime()) / 60_000),
      );
      reservation = await this.#cal.reserveSlot({
        eventTypeId: type.id,
        slotStart: start.toISOString(),
        reservationDuration: minutes,
      });
    } catch (e) {
      this.#inFlight.delete(slotKey);
      throw this.#mapError(e, 'slot_unavailable', 'That time was just taken.');
    }

    const slot = this.#slot(type, start, undefined, req.slot_id);
    const now = ctx.now.toISOString();
    const booking: Booking = {
      booking_id: `bk_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      status: 'held',
      venue_id: this.#opts.venue.id,
      slot,
      customer: req.customer,
      notes: req.notes,
      expires_at: req.expires_at.toISOString(),
      confirmation_code: null,
      payment: { status: 'not_required', amount: null, reference: null },
      cancellation: null,
      created_at: now,
      updated_at: now,
      confirmed_at: null,
      cancelled_at: null,
    };
    await this.#store.put({
      booking,
      reservationUid: reservation.reservationUid,
      calUid: null,
      eventTypeId: type.id,
    });
    this.#inFlight.delete(slotKey);
    return structuredClone(booking);
  }

  async confirmHold(req: ConfirmHoldRequest, ctx: ProviderContext): Promise<Booking> {
    const rec = await this.#record(req.booking_id);
    const b = rec.booking;
    if (b.status !== 'held')
      throw new BookingError('invalid_state', `Booking is ${b.status}, not held.`);
    if (b.expires_at && new Date(b.expires_at).getTime() <= ctx.now.getTime()) {
      throw new BookingError('hold_expired', `The hold expired at ${b.expires_at}.`);
    }
    if (!req.customer.email) {
      throw new BookingError(
        'customer_details_required',
        'This business needs an email address to book.',
        {
          suggested_next_action:
            'Ask the user for their email address and call confirm_booking again with it.',
        },
      );
    }

    let cal;
    try {
      cal = await this.#cal.createBooking({
        start: new Date(b.slot.start).toISOString(),
        eventTypeId: rec.eventTypeId,
        attendee: {
          name: `${req.customer.first_name} ${req.customer.last_name}`,
          email: req.customer.email,
          timeZone: this.#opts.venue.timezone,
          ...(req.customer.phone_number ? { phoneNumber: req.customer.phone_number } : {}),
        },
        metadata: { openbooking_booking_id: b.booking_id },
      });
    } catch (e) {
      throw this.#mapError(e, 'slot_unavailable', 'Cal.com could not book this time.');
    }
    // The reservation has served its purpose; free it (best effort).
    if (rec.reservationUid) await this.#cal.deleteReservation(rec.reservationUid).catch(() => {});

    const at = ctx.now.toISOString();
    b.status = 'confirmed';
    b.customer = req.customer;
    b.expires_at = null;
    b.confirmation_code = cal.uid.slice(0, 8).toUpperCase();
    b.confirmed_at = at;
    b.updated_at = at;
    if (cal.status === 'pending' || cal.status === 'awaiting_host') {
      b.notes = [b.notes, 'Awaiting confirmation from the business.'].filter(Boolean).join(' ');
    }
    await this.#store.put({ ...rec, booking: b, calUid: cal.uid, reservationUid: null });
    return structuredClone(b);
  }

  async getBooking(bookingId: string, ctx: ProviderContext): Promise<Booking | null> {
    const rec = await this.#store.get(bookingId);
    if (!rec) return null;
    const b = rec.booking;
    if (b.status === 'held' && b.expires_at && new Date(b.expires_at) <= ctx.now) {
      b.status = 'expired';
      await this.#store.put(rec);
    }
    if (b.status === 'confirmed' && rec.calUid && this.#opts.refreshOnRead !== false) {
      try {
        const cal = await this.#cal.getBooking(rec.calUid);
        if (cal.status === 'cancelled' || cal.status === 'rejected') {
          b.status = 'cancelled';
          b.cancelled_at = ctx.now.toISOString();
          b.updated_at = b.cancelled_at;
          b.cancellation = {
            reason: cal.cancellationReason ?? `Cancelled in Cal.com (${cal.status}).`,
            fee: null,
            refund: null,
          };
          await this.#store.put(rec);
        }
      } catch {
        // Cal.com unreachable: serve the last known state.
      }
    }
    return structuredClone(b);
  }

  async updateBooking(req: UpdateBookingRequest, ctx: ProviderContext): Promise<Booking> {
    const rec = await this.#record(req.booking_id);
    if (rec.booking.status !== 'held') {
      throw new BookingError(
        'operation_not_supported',
        'Confirmed Cal.com bookings cannot be edited here.',
        {
          suggested_next_action:
            'Cancel and book again, or ask the business to change it in Cal.com.',
        },
      );
    }
    if (req.customer) rec.booking.customer = req.customer;
    if (req.notes !== undefined) rec.booking.notes = req.notes;
    rec.booking.updated_at = ctx.now.toISOString();
    await this.#store.put(rec);
    return structuredClone(rec.booking);
  }

  async cancelBooking(req: CancelBookingRequest, ctx: ProviderContext): Promise<Booking> {
    const rec = await this.#record(req.booking_id);
    if (rec.booking.status === 'held' && rec.reservationUid) {
      await this.#cal.deleteReservation(rec.reservationUid).catch(() => {});
    } else if (rec.booking.status === 'confirmed' && rec.calUid) {
      try {
        await this.#cal.cancelBooking(rec.calUid, req.reason ?? undefined);
      } catch (e) {
        throw this.#mapError(e, 'provider_error', 'Cal.com could not cancel the booking.');
      }
    }
    const b = rec.booking;
    b.status = 'cancelled';
    b.expires_at = null;
    b.cancelled_at = ctx.now.toISOString();
    b.updated_at = b.cancelled_at;
    b.cancellation = { reason: req.reason, fee: req.fee, refund: req.refund };
    await this.#store.put({ ...rec, reservationUid: null });
    return structuredClone(b);
  }

  async listBookings(
    query: { from?: Date; to?: Date; limit?: number },
    _ctx: ProviderContext,
  ): Promise<Booking[]> {
    return (await this.#store.list())
      .map((r) => r.booking)
      .filter((b) => {
        const t = new Date(b.slot.start).getTime();
        return (!query.from || t >= query.from.getTime()) && (!query.to || t < query.to.getTime());
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, query.limit ?? 500)
      .map((b) => structuredClone(b));
  }

  // ---------------------------------------------------------------------------

  async #eventTypesList(): Promise<CalEventType[]> {
    if (this.#eventTypes && Date.now() - this.#eventTypes.at < 5 * 60_000)
      return this.#eventTypes.list;
    const all = await this.#call(() => this.#cal.listEventTypes());
    const ids = this.#opts.eventTypeIds;
    const list = all.filter((t) => (ids ? ids.includes(t.id) : !t.hidden));
    this.#eventTypes = { at: Date.now(), list };
    return list;
  }

  async #record(id: string): Promise<CalcomRecord> {
    const rec = await this.#store.get(id);
    if (!rec) throw new BookingError('not_found', `No booking with id "${id}".`);
    return rec;
  }

  #slot(type: CalEventType, start: Date, end?: Date, slotId?: string): Slot {
    const tz = this.#opts.venue.timezone;
    const stop = end ?? new Date(start.getTime() + type.lengthInMinutes * 60_000);
    const currency = (type.currency ?? this.#opts.venue.currency ?? 'USD').toUpperCase();
    const price =
      type.price && type.price > 0
        ? {
            amount: this.#opts.priceUnit === 'major' ? Math.round(type.price * 100) : type.price,
            currency,
          }
        : null;
    return {
      slot_id: slotId ?? encodeSlotId({ e: type.id, s: start.toISOString() }),
      venue_id: this.#opts.venue.id,
      offering: { id: String(type.id), name: type.title },
      start: time.formatInZone(start, tz),
      end: time.formatInZone(stop, tz),
      party_size: { total: 1 },
      price,
      deposit: null,
      cancellation_policy: this.#policy(start),
    };
  }

  #policy(start: Date): CancellationPolicy {
    const r = this.#opts.cancellation ?? {};
    const hours = r.free_until_hours_before === undefined ? 24 : r.free_until_hours_before;
    const tz = this.#opts.venue.timezone;
    const freeUntil =
      hours === null ? null : time.formatInZone(new Date(start.getTime() - hours * 3_600_000), tz);
    const fee = r.late_fee ?? null;
    return {
      refundability: r.refundability ?? 'refundable',
      description: [
        freeUntil
          ? `Free cancellation until ${freeUntil} (${hours} hours before).`
          : 'Not refundable.',
        fee ? `Later cancellations cost ${(fee.amount / 100).toFixed(0)} ${fee.currency}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      free_cancellation_until: freeUntil,
      late_cancellation_fee: fee,
      no_show_fee: r.no_show_fee ?? null,
    };
  }

  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.#mapError(e, 'provider_error', 'Cal.com request failed.');
    }
  }

  #mapError(
    e: unknown,
    fallback: 'slot_unavailable' | 'provider_error',
    message: string,
  ): BookingError {
    if (e instanceof BookingError) return e;
    if (e instanceof CalApiError) {
      if (e.status === 401 || e.status === 403) {
        return new BookingError('provider_error', 'Cal.com rejected the API key.', {
          retryable: false,
          suggested_next_action:
            'Tell the user the business booking system is misconfigured and to contact the business.',
          details: { cal_status: e.status },
        });
      }
      if (e.status === 429 || e.status >= 500) {
        return new BookingError('provider_error', 'Cal.com is temporarily unavailable.', {
          details: { cal_status: e.status },
        });
      }
      return new BookingError(fallback, `${message} (${e.message})`, {
        details: { cal_status: e.status },
      });
    }
    return new BookingError('provider_error', message, { cause: e });
  }
}

export function encodeSlotId(key: SlotKey): string {
  return `cal_${Buffer.from(JSON.stringify(key)).toString('base64url')}`;
}

function decodeSlotId(id: string): SlotKey {
  try {
    if (!id.startsWith('cal_')) throw new Error();
    const k = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8')) as SlotKey;
    if (typeof k.e !== 'number' || typeof k.s !== 'string') throw new Error();
    return k;
  } catch {
    throw invalidSlot();
  }
}

function invalidSlot(): BookingError {
  return new BookingError('validation_error', 'slot_id is not valid.', {
    suggested_next_action: 'Use a slot_id exactly as returned by search_availability.',
  });
}
