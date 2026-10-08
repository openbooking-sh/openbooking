import { BookingError, type Booking, type BookingProvider, type Slot } from '@openbooking-sh/core';
import { describe, expect, it } from 'vitest';
import { runProviderConformance, type ConformanceOptions } from '../src';

/**
 * A tiny provider with room for two bookings per slot, and switches to break one promise at a
 * time. The suite must pass the healthy one and name the broken promise in each other case.
 */
interface Defects {
  /** Checks capacity, then yields, then writes: two callers can both pass the check. */
  racy?: boolean;
  /** Never reads the clock: expired holds keep blocking. */
  holdsNeverExpire?: boolean;
  /** Cancelling does not free the place. */
  cancelKeepsPlace?: boolean;
  /** Ignores capacity entirely. */
  overbooks?: boolean;
  /** Throws a plain Error for unknown ids. */
  plainErrors?: boolean;
}

const NOW = new Date('2030-06-03T08:00:00Z');
const CAPACITY = 2;

const slot = (n: number): Slot => ({
  slot_id: `slot-${n}`,
  venue_id: 'v1',
  offering: { id: 'dinner', name: 'Dinner' },
  start: `2030-06-04T${String(17 + n).padStart(2, '0')}:00:00+00:00`,
  end: `2030-06-04T${String(18 + n).padStart(2, '0')}:00:00+00:00`,
  party_size: { total: 2 },
  price: null,
  deposit: null,
  cancellation_policy: {
    refundability: 'refundable',
    description: 'Free cancellation.',
    free_cancellation_until: null,
    late_cancellation_fee: null,
    no_show_fee: null,
  },
});

class Naive implements BookingProvider {
  readonly info = { name: 'Naive' };
  readonly #slots = [slot(0), slot(1), slot(2)];
  readonly #bookings = new Map<string, Booking>();
  #seq = 0;
  constructor(private readonly defects: Defects = {}) {}

  async listVenues() {
    return [{ id: 'v1', name: 'Naive', timezone: 'UTC' }];
  }

  #taken(slotId: string, now: Date) {
    return [...this.#bookings.values()].filter((b) => {
      if (b.slot.slot_id !== slotId) return false;
      if (b.status === 'confirmed') return true;
      if (b.status !== 'held') return b.status === 'cancelled' && !!this.defects.cancelKeepsPlace;
      return this.defects.holdsNeverExpire || Date.parse(b.expires_at!) > now.getTime();
    }).length;
  }

  async searchAvailability(_q: unknown, ctx: { now: Date }): Promise<Slot[]> {
    return this.#slots.filter((s) => this.#taken(s.slot_id, ctx.now) < CAPACITY);
  }

  async createHold(
    req: Parameters<BookingProvider['createHold']>[0],
    ctx: { now: Date },
  ): Promise<Booking> {
    const s = this.#slots.find((x) => x.slot_id === req.slot_id);
    if (!s) throw new BookingError('not_found', 'no such slot');
    const full = () => !this.defects.overbooks && this.#taken(s.slot_id, ctx.now) >= CAPACITY;
    if (full()) throw new BookingError('slot_unavailable', 'full');
    if (this.defects.racy) await Promise.resolve();
    else if (full()) throw new BookingError('slot_unavailable', 'full');
    const at = ctx.now.toISOString();
    const b: Booking = {
      booking_id: `b${++this.#seq}`,
      status: 'held',
      venue_id: 'v1',
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
    this.#bookings.set(b.booking_id, b);
    return b;
  }

  #get(id: string, now: Date): Booking {
    const b = this.#bookings.get(id);
    if (!b) {
      if (this.defects.plainErrors) throw new Error('boom');
      throw new BookingError('not_found', 'no such booking');
    }
    return b.status === 'held' &&
      !this.defects.holdsNeverExpire &&
      Date.parse(b.expires_at!) <= now.getTime()
      ? { ...b, status: 'expired' }
      : b;
  }

  async confirmHold(req: Parameters<BookingProvider['confirmHold']>[0], ctx: { now: Date }) {
    const b = this.#get(req.booking_id, ctx.now);
    if (b.status === 'expired') throw new BookingError('hold_expired', 'expired');
    const done: Booking = {
      ...b,
      status: 'confirmed',
      customer: req.customer,
      expires_at: null,
      confirmed_at: ctx.now.toISOString(),
      confirmation_code: 'C' + b.booking_id,
    };
    this.#bookings.set(b.booking_id, done);
    return done;
  }

  async getBooking(id: string, ctx: { now: Date }) {
    return this.#bookings.has(id) ? this.#get(id, ctx.now) : null;
  }

  async cancelBooking(req: Parameters<BookingProvider['cancelBooking']>[0], ctx: { now: Date }) {
    const b = this.#get(req.booking_id, ctx.now);
    if (b.status === 'cancelled') throw new BookingError('invalid_state', 'already cancelled');
    const done: Booking = {
      ...b,
      status: 'cancelled',
      cancelled_at: ctx.now.toISOString(),
      cancellation: { reason: req.reason, fee: req.fee, refund: req.refund },
    };
    this.#bookings.set(b.booking_id, done);
    return done;
  }
}

const options = (defects?: Defects): ConformanceOptions => ({
  create: () => new Naive(defects),
  now: NOW,
  query: { date: '2030-06-04', party_size: { total: 2 } },
});

const failures = async (defects?: Defects) =>
  (await runProviderConformance(options(defects))).filter((r) => !r.ok).map((r) => r.name);

describe('the suite itself', () => {
  it('passes a correct provider that is not the memory provider', async () => {
    expect(await failures()).toEqual([]);
  });

  it('catches check-then-write races between simultaneous holds', async () => {
    expect(await failures({ racy: true })).toContain(
      'holds > never grants more holds than the slot has room for, however many ask at once',
    );
  });

  it('catches holds that never expire', async () => {
    const failed = await failures({ holdsNeverExpire: true });
    expect(failed).toContain('expiry > stops blocking a full slot once its holds have expired');
    expect(failed).toContain('expiry > reports an expired hold as expired, never as held');
  });

  it('catches cancellations that do not free the place', async () => {
    expect(await failures({ cancelKeepsPlace: true })).toContain(
      'cancelling > releases a hold and frees its place at once',
    );
  });

  it('catches overbooking', async () => {
    const failed = await failures({ overbooks: true });
    expect(failed.some((n) => n.startsWith('holds >'))).toBe(true);
  });

  it('catches errors that are not BookingErrors', async () => {
    expect(await failures({ plainErrors: true })).toContain(
      'cancelling > answers an unknown booking id with not_found',
    );
  });
});
