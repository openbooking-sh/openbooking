import type { Booking, BookingService } from '@openbooking/core';
import { calendarFor, type CalendarSyncConfig } from './busy';
import { BOOKING_ID_PROPERTY, type GoogleCalendarClient } from './client';
import { GoogleAuthError } from './oauth';

/** The Google event that mirrors a booking. */
export interface CalendarLink {
  calendar_id: string;
  event_id: string;
}

/** booking id → Google event. Memory by default; a durable store makes sync safe across instances. */
export interface CalendarLinkStore {
  get(bookingId: string): Promise<CalendarLink | undefined>;
  set(bookingId: string, link: CalendarLink): Promise<void>;
  delete(bookingId: string): Promise<void>;
}

export class MemoryCalendarLinkStore implements CalendarLinkStore {
  readonly #links = new Map<string, CalendarLink>();

  async get(bookingId: string) {
    const link = this.#links.get(bookingId);
    return link ? { ...link } : undefined;
  }

  async set(bookingId: string, link: CalendarLink) {
    this.#links.set(bookingId, { ...link });
  }

  async delete(bookingId: string) {
    this.#links.delete(bookingId);
  }
}

export interface CalendarSyncOptions {
  service: BookingService;
  client: GoogleCalendarClient;
  config: () => CalendarSyncConfig | Promise<CalendarSyncConfig>;
  links?: CalendarLinkStore;
  onError?: (error: unknown) => void;
  /** The Google connection is gone. Defaults to `onError`. */
  onAuthError?: (error: GoogleAuthError) => void;
}

export interface CalendarSync {
  detach(): void;
  /** Resolves once every event seen so far is synced (or failed). */
  idle(): Promise<void>;
}

/**
 * Mirror bookings into Google Calendar: a confirmed booking becomes an event on the staff
 * member's calendar, and cancelling it deletes the event. Runs in the background in event
 * order; failures go to `onError` and never affect bookings.
 *
 * Confirm is state-idempotent, so the same booking can emit several confirm events. The link
 * check makes that harmless within one process; a durable CalendarLinkStore (Postgres) is what
 * makes it safe across instances.
 */
export function attachCalendarSync(opts: CalendarSyncOptions): CalendarSync {
  const { service, client } = opts;
  const links = opts.links ?? new MemoryCalendarLinkStore();
  const onError =
    opts.onError ??
    ((error: unknown) => console.error('[openbooking] Google Calendar sync failed', error));
  const fail = (error: unknown) =>
    error instanceof GoogleAuthError && opts.onAuthError ? opts.onAuthError(error) : onError(error);

  let tail: Promise<void> = Promise.resolve();
  const run = (work: () => Promise<void>) => {
    tail = tail.then(work).catch(fail);
  };

  const insert = async (booking: Booking, via: string) => {
    if (await links.get(booking.booking_id)) return;
    const [venue, config] = await Promise.all([
      service.resolveVenue(booking.venue_id),
      opts.config(),
    ]);
    const calendarId = calendarFor(config, booking.slot.resource?.id);
    const c = booking.customer;
    const name = c ? `${c.first_name} ${c.last_name}` : 'Guest';
    const party = booking.slot.party_size.total;
    const description = [
      c?.phone_number ? `Phone: ${c.phone_number}` : '',
      c?.email ? `Email: ${c.email}` : '',
      party > 1 ? `Party size: ${party}` : '',
      booking.notes ? `Notes: ${booking.notes}` : '',
      `Booked via ${via}`,
      booking.confirmation_code ? `Confirmation code: ${booking.confirmation_code}` : '',
    ].filter(Boolean);
    const event = await client.insertEvent(calendarId, {
      summary: `${booking.slot.offering.name} – ${name}`,
      description: description.join('\n'),
      start: booking.slot.start,
      end: booking.slot.end,
      timeZone: venue.timezone,
      privateProperties: { [BOOKING_ID_PROPERTY]: booking.booking_id },
    });
    await links.set(booking.booking_id, { calendar_id: calendarId, event_id: event.id });
  };

  const remove = async (booking: Booking) => {
    const link = await links.get(booking.booking_id);
    if (!link) return;
    await client.deleteEvent(link.calendar_id, link.event_id);
    await links.delete(booking.booking_id);
  };

  const detach = service.on((e) => {
    const booking = e.booking;
    if (!e.ok || !booking) return;
    if (e.operation === 'confirm' && booking.status === 'confirmed') {
      const via = e.actor?.agent ?? 'OpenBooking';
      run(() => insert(booking, via));
    } else if (e.operation === 'cancel' && booking.status === 'cancelled') {
      run(() => remove(booking));
    }
  });

  return { detach, idle: () => tail };
}
