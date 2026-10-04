import {
  BookingError,
  type Booking,
  type BookingProvider,
  type CancellationPolicy,
  type Slot,
  type Venue,
} from '../src';

export const VENUE: Venue = { id: 'v1', name: 'Test Bistro', timezone: 'UTC' };

export const START = '2026-10-10T19:00:00+00:00';

export function policy(overrides: Partial<CancellationPolicy> = {}): CancellationPolicy {
  return {
    refundability: 'refundable',
    description: 'Free cancellation until 24h before.',
    free_cancellation_until: '2026-10-09T19:00:00+00:00',
    late_cancellation_fee: { amount: 20000, currency: 'NOK' },
    no_show_fee: null,
    ...overrides,
  };
}

export function slot(overrides: Partial<Slot> = {}): Slot {
  return {
    slot_id: 'slot-1',
    venue_id: VENUE.id,
    offering: { id: 'dinner', name: 'Dinner' },
    start: START,
    end: '2026-10-10T20:30:00+00:00',
    party_size: { total: 2 },
    price: null,
    deposit: null,
    cancellation_policy: policy(),
    ...overrides,
  };
}

/**
 * A tiny single-slot provider for engine tests. It counts calls so tests can assert that
 * idempotent retries never reach the provider twice.
 */
export class TinyProvider implements BookingProvider {
  readonly info = { name: 'Tiny' };
  readonly bookings = new Map<string, Booking>();
  calls = { createHold: 0, confirmHold: 0, cancelBooking: 0, updateBooking: 0 };
  #seq = 0;

  constructor(public slots: Slot[] = [slot()]) {}

  async listVenues() {
    return [VENUE];
  }

  async searchAvailability() {
    return this.slots.filter((s) => !this.#taken(s.slot_id, new Date(0)));
  }

  #taken(slotId: string, now: Date) {
    return [...this.bookings.values()].some(
      (b) =>
        b.slot.slot_id === slotId &&
        (b.status === 'confirmed' ||
          (b.status === 'held' && new Date(b.expires_at!).getTime() > now.getTime())),
    );
  }

  async createHold(req: Parameters<BookingProvider['createHold']>[0], ctx: { now: Date }) {
    this.calls.createHold++;
    const s = this.slots.find((x) => x.slot_id === req.slot_id);
    if (!s) throw new BookingError('not_found', 'no slot');
    if (this.#taken(s.slot_id, ctx.now)) throw new BookingError('slot_unavailable', 'taken');
    const now = ctx.now.toISOString();
    const b: Booking = {
      booking_id: `b${++this.#seq}`,
      status: 'held',
      venue_id: VENUE.id,
      slot: s,
      customer: req.customer,
      notes: req.notes,
      expires_at: req.expires_at.toISOString(),
      confirmation_code: null,
      payment: {
        status: s.deposit ? 'pending' : 'not_required',
        amount: s.deposit?.amount ?? null,
        reference: null,
      },
      cancellation: null,
      created_at: now,
      updated_at: now,
      confirmed_at: null,
      cancelled_at: null,
    };
    this.bookings.set(b.booking_id, b);
    return structuredClone(b);
  }

  async confirmHold(req: Parameters<BookingProvider['confirmHold']>[0], ctx: { now: Date }) {
    this.calls.confirmHold++;
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
      payment: b.slot.deposit
        ? { status: 'paid', amount: b.slot.deposit.amount, reference: req.payment_token }
        : b.payment,
    });
    return structuredClone(b);
  }

  async getBooking(id: string) {
    const b = this.bookings.get(id);
    return b ? structuredClone(b) : null;
  }

  async updateBooking(req: Parameters<NonNullable<BookingProvider['updateBooking']>>[0]) {
    this.calls.updateBooking++;
    const b = this.bookings.get(req.booking_id)!;
    if (req.customer) b.customer = req.customer;
    if (req.notes !== undefined) b.notes = req.notes;
    return structuredClone(b);
  }

  async cancelBooking(req: Parameters<BookingProvider['cancelBooking']>[0], ctx: { now: Date }) {
    this.calls.cancelBooking++;
    const b = this.bookings.get(req.booking_id)!;
    Object.assign(b, {
      status: 'cancelled',
      expires_at: null,
      cancelled_at: ctx.now.toISOString(),
      cancellation: { reason: req.reason, fee: req.fee, refund: req.refund },
    });
    return structuredClone(b);
  }
}

export const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
