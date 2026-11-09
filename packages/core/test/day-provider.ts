import { BookingError, type Booking, type BookingProvider, type Slot } from '../src';
import { VENUE, slot } from './fixtures';

export const DATE = '2026-10-10';

/** Two evening slots on one day. A slot is free unless a confirmed booking or a live hold has it. */
export class DayProvider implements BookingProvider {
  readonly info = { name: 'Day' };
  readonly bookings = new Map<string, Booking>();
  readonly slots: Slot[] = [
    slot({ slot_id: 's19', start: `${DATE}T19:00:00+00:00`, end: `${DATE}T20:30:00+00:00` }),
    slot({ slot_id: 's21', start: `${DATE}T21:00:00+00:00`, end: `${DATE}T22:30:00+00:00` }),
  ];
  holds = 0;
  #seq = 0;

  async listVenues() {
    return [VENUE];
  }

  #blocks(b: Booking, now: Date) {
    return (
      b.status === 'confirmed' ||
      (b.status === 'held' && new Date(b.expires_at!).getTime() > now.getTime())
    );
  }

  #free(s: Slot, now: Date) {
    return ![...this.bookings.values()].some(
      (b) => b.slot.slot_id === s.slot_id && this.#blocks(b, now),
    );
  }

  async searchAvailability(
    q: { date: string; time_from?: string; time_to?: string; offering_id?: string },
    ctx: { now: Date },
  ) {
    return this.slots.filter(
      (s) =>
        s.start.startsWith(q.date) &&
        this.#free(s, ctx.now) &&
        (!q.offering_id || s.offering.id === q.offering_id) &&
        (!q.time_from || s.start.slice(11, 16) >= q.time_from) &&
        (!q.time_to || s.start.slice(11, 16) <= q.time_to),
    );
  }

  async createHold(req: Parameters<BookingProvider['createHold']>[0], ctx: { now: Date }) {
    const s = this.slots.find((x) => x.slot_id === req.slot_id);
    if (!s) throw new BookingError('not_found', 'no slot');
    // Check and write in one tick: the provider contract is that two holds never both succeed.
    if (!this.#free(s, ctx.now)) throw new BookingError('slot_unavailable', 'taken');
    this.holds++;
    const at = ctx.now.toISOString();
    const b: Booking = {
      booking_id: `b${++this.#seq}`,
      status: 'held',
      venue_id: VENUE.id,
      slot: s,
      customer: req.customer,
      notes: req.notes,
      expires_at: req.expires_at.toISOString(),
      confirmation_code: null,
      payment: { status: 'not_required', amount: null, reference: null },
      cancellation: null,
      created_at: at,
      updated_at: at,
      confirmed_at: null,
      cancelled_at: null,
    };
    this.bookings.set(b.booking_id, b);
    return structuredClone(b);
  }

  async confirmHold(req: Parameters<BookingProvider['confirmHold']>[0], ctx: { now: Date }) {
    const b = this.bookings.get(req.booking_id)!;
    if (new Date(b.expires_at!).getTime() <= ctx.now.getTime()) {
      throw new BookingError('hold_expired', 'expired');
    }
    Object.assign(b, {
      status: 'confirmed',
      customer: req.customer,
      expires_at: null,
      confirmation_code: `C-${b.booking_id}`,
      confirmed_at: ctx.now.toISOString(),
    });
    return structuredClone(b);
  }

  async getBooking(id: string) {
    const b = this.bookings.get(id);
    return b ? structuredClone(b) : null;
  }

  async cancelBooking(req: Parameters<BookingProvider['cancelBooking']>[0], ctx: { now: Date }) {
    const b = this.bookings.get(req.booking_id)!;
    if (req.release_hold && b.status !== 'held')
      throw new BookingError('invalid_state', 'not held');
    Object.assign(b, {
      status: 'cancelled',
      expires_at: null,
      cancelled_at: ctx.now.toISOString(),
      cancellation: { reason: req.reason, fee: req.fee, refund: req.refund },
    });
    return structuredClone(b);
  }

  async listBookings() {
    return [...this.bookings.values()].map((b) => structuredClone(b));
  }
}
