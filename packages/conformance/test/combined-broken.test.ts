import { BookingError, type Booking, type BookingProvider, type Slot } from '@openbooking-sh/core';
import { describe, expect, it } from 'vitest';
import { runProviderConformance, type ConformanceOptions } from '../src';

/**
 * A tiny restaurant whose every booking is at joined tables, with switches to break one promise at
 * a time. Pairs overlap (A+B, B+C, C+D), so a provider that forgets one table of a pair shows it:
 * the suite must pass the healthy one and name the broken promise in each other case.
 */
interface Defects {
  /** Only looks at, and claims, the first table of a pair. */
  firstTableOnly?: boolean;
  /** Cancelling gives back the first table only; the others stay taken. */
  cancelFreesFirstOnly?: boolean;
  /** Expiry is never applied to the other tables: they stay taken after the hold lapses. */
  expiryLeaksOtherTables?: boolean;
}

const NOW = new Date('2030-06-03T08:00:00Z');
const PAIRS = [
  ['A', 'B'],
  ['B', 'C'],
  ['C', 'D'],
];

const slotAt = (n: number, pair?: string[]): Slot => ({
  slot_id: `slot-${n}`,
  venue_id: 'v1',
  offering: { id: 'dinner', name: 'Dinner' },
  start: `2030-06-04T${String(17 + 2 * n).padStart(2, '0')}:00:00+00:00`,
  end: `2030-06-04T${String(18 + 2 * n).padStart(2, '0')}:00:00+00:00`,
  party_size: { total: 6 },
  ...(pair
    ? {
        resource: {
          id: pair[0]!,
          kind: 'table',
          label: `Tables ${pair.join(' and ')} together`,
          tags: [],
        },
        additional_resources: pair
          .slice(1)
          .map((id) => ({ id, kind: 'table', label: `Table ${id}` })),
      }
    : {}),
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

class JoinedBistro implements BookingProvider {
  readonly info = { name: 'JoinedBistro' };
  readonly #bookings = new Map<string, Booking & { tables: string[] }>();
  #seq = 0;
  constructor(private readonly defects: Defects = {}) {}

  async listVenues() {
    return [{ id: 'v1', name: 'JoinedBistro', timezone: 'UTC' }];
  }

  #claimed(slotId: string, now: Date): Set<string> {
    const taken = new Set<string>();
    for (const b of this.#bookings.values()) {
      if (b.slot.slot_id !== slotId) continue;
      const lapsed = b.status === 'held' && Date.parse(b.expires_at!) <= now.getTime();
      const active = b.status === 'confirmed' || (b.status === 'held' && !lapsed);
      if (active) b.tables.forEach((t) => taken.add(t));
      else if (lapsed && this.defects.expiryLeaksOtherTables)
        b.tables.slice(1).forEach((t) => taken.add(t));
      else if (b.status === 'cancelled' && this.defects.cancelFreesFirstOnly) {
        b.tables.slice(1).forEach((t) => taken.add(t));
      }
    }
    return taken;
  }

  #pairFor(slotId: string, now: Date): string[] | undefined {
    const taken = this.#claimed(slotId, now);
    return PAIRS.find((p) =>
      this.defects.firstTableOnly ? !taken.has(p[0]!) : p.every((t) => !taken.has(t)),
    );
  }

  async searchAvailability(_q: unknown, ctx: { now: Date }): Promise<Slot[]> {
    return [0, 1, 2].flatMap((n) => {
      const pair = this.#pairFor(`slot-${n}`, ctx.now);
      return pair ? [slotAt(n, pair)] : [];
    });
  }

  async createHold(req: Parameters<BookingProvider['createHold']>[0], ctx: { now: Date }) {
    const n = Number(req.slot_id.replace('slot-', ''));
    if (!Number.isInteger(n) || n < 0 || n > 2) throw new BookingError('not_found', 'no such slot');
    const pair = this.#pairFor(req.slot_id, ctx.now);
    if (!pair) throw new BookingError('slot_unavailable', 'full');
    const at = ctx.now.toISOString();
    const b = {
      booking_id: `b${++this.#seq}`,
      status: 'held' as const,
      venue_id: 'v1',
      slot: slotAt(n, pair),
      // A provider that only claims the first table.
      tables: this.defects.firstTableOnly ? [pair[0]!] : pair,
      customer: req.customer,
      notes: req.notes,
      expires_at: req.expires_at.toISOString(),
      confirmation_code: null,
      payment: { status: 'not_required' as const, amount: null, reference: null },
      cancellation: null,
      created_at: at,
      updated_at: at,
      confirmed_at: null,
      cancelled_at: null,
    };
    this.#bookings.set(b.booking_id, b);
    return b;
  }

  #get(id: string, now: Date) {
    const b = this.#bookings.get(id);
    if (!b) throw new BookingError('not_found', 'no such booking');
    return b.status === 'held' && Date.parse(b.expires_at!) <= now.getTime()
      ? { ...b, status: 'expired' as const }
      : b;
  }

  async confirmHold(req: Parameters<BookingProvider['confirmHold']>[0], ctx: { now: Date }) {
    const b = this.#get(req.booking_id, ctx.now);
    if (b.status === 'expired') throw new BookingError('hold_expired', 'expired');
    const done = {
      ...b,
      status: 'confirmed' as const,
      customer: req.customer,
      expires_at: null,
      confirmed_at: ctx.now.toISOString(),
      confirmation_code: `C${b.booking_id}`,
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
    const done = {
      ...b,
      status: 'cancelled' as const,
      cancelled_at: ctx.now.toISOString(),
      cancellation: { reason: req.reason, fee: req.fee, refund: req.refund },
    };
    this.#bookings.set(b.booking_id, done);
    return done;
  }
}

const query = { date: '2030-06-04', party_size: { total: 6 } };

const options = (defects?: Defects): ConformanceOptions => ({
  create: () => new JoinedBistro(defects),
  now: NOW,
  query,
  combinedTables: { query },
});

const failures = async (defects?: Defects) =>
  (await runProviderConformance(options(defects))).filter((r) => !r.ok).map((r) => r.name);

const GROUP = 'combined tables (opt-in: options.combinedTables) > ';

describe('the joined-tables checks', () => {
  it('pass a correct provider that is not the memory provider', async () => {
    expect(await failures()).toEqual([]);
  });

  it('are not run unless the provider opts in', async () => {
    const results = await runProviderConformance({ ...options(), combinedTables: undefined });
    expect(results.some((r) => r.name.startsWith(GROUP))).toBe(false);
  });

  it('catch a provider that claims only the first table of a joined booking', async () => {
    const failed = await failures({ firstTableOnly: true });
    expect(failed).toContain(
      GROUP + 'claims every table of a joined booking, so no two bookings share one',
    );
  });

  it('catch a cancellation that frees only some of the tables', async () => {
    const failed = await failures({ cancelFreesFirstOnly: true });
    expect(failed).toContain(GROUP + 'frees every table when a hold is cancelled, and no more');
  });

  it('catch an expiry that leaves tables taken', async () => {
    const failed = await failures({ expiryLeaksOtherTables: true });
    expect(failed).toContain(GROUP + 'frees every table when a hold expires');
  });
});
