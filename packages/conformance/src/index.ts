/**
 * Conformance suite for `BookingProvider`s.
 *
 * The BookingService (core) promises agents that nothing double-books, holds expire and errors are
 * actionable. It can only keep those promises if the provider underneath does its part, so this
 * suite checks the provider directly, with no engine in between:
 *
 * ```ts
 * import { describeProviderConformance } from '@openbooking-sh/conformance/vitest';
 *
 * describeProviderConformance('MySystemProvider', {
 *   create: () => new MySystemProvider(testConfig), // a fresh, empty provider per test
 *   now: new Date('2030-06-03T08:00:00Z'),
 *   query: { date: '2030-06-04', party_size: { total: 1 } },
 * });
 * ```
 *
 * Run it with vitest (or call `runProviderConformance()` from any other runner). Optional provider methods (`updateBooking`, `rescheduleBooking`,
 * `listBookings`, ...) are only tested when the provider implements them.
 *
 * A `slot_id` may stand for more than one place (a salon slot is open while any stylist is free;
 * a restaurant time while any table is). The suite therefore never assumes a capacity of one: it
 * books a slot until the provider says `slot_unavailable`, then checks that the provider stopped
 * exactly there, however many parallel callers tried.
 */
import {
  BookingError,
  BookingSchema,
  OfferingSchema,
  ResourceSchema,
  SlotSchema,
  VenueInfoSchema,
  VenueSchema,
  type AvailabilityQueryInput,
  type Booking,
  type BookingProvider,
  type Customer,
  type Money,
  type ProviderContext,
  type Slot,
} from '@openbooking-sh/core';
import { expect } from './expect';

export interface ConformanceOptions {
  /** A new provider with no bookings. Called before every test, so tests never share state. */
  create: () => BookingProvider | Promise<BookingProvider>;
  /**
   * The instant the provider is told it is. Pick a time well before `query.date` (but inside the
   * booking window), so slots are not hidden by lead-time rules.
   */
  now: Date;
  /**
   * A search that returns at least one free slot, and another slot at a different time once the
   * first is fully booked. None of the slots may need a deposit at confirmation (the suite
   * confirms without a payment token unless you set `paymentToken`). Pin `offering_id` if the
   * venue sells services with deposits.
   */
  query: Omit<AvailabilityQueryInput, 'limit'>;
  /** Only when every bookable slot has a deposit due at confirmation. */
  paymentToken?: string;
  /** How long test holds last. Default 5 minutes. */
  holdSeconds?: number;
  /**
   * Checks to skip, by full name (as in the results), each with the reason. For limits of your
   * test setup, not of the provider: for example a fake backend that cannot let holds expire.
   */
  skip?: Record<string, string>;
}

const CUSTOMER: Customer = {
  first_name: 'Conformance',
  last_name: 'Tester',
  email: 'conformance@example.com',
  phone_number: '+4790000000',
};

const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A slot holding more than this many bookings is treated as unbounded, which is a bug. */
const MAX_CAPACITY = 60;

export interface Check {
  /** Group and test name, e.g. `holds > refuses further holds on a full slot`. */
  name: string;
  run: () => Promise<void>;
  /** Why the check is skipped, when `options.skip` lists it. */
  skipped?: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
  /** Set when the check was skipped; `ok` is then true. */
  skipped?: string;
}

/**
 * Runs every check and reports the results, without a test runner. Use it to assert that a
 * deliberately broken provider is caught, or to print a report in CI.
 */
export async function runProviderConformance(options: ConformanceOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of conformanceChecks(options)) {
    if (check.skipped) {
      results.push({ name: check.name, ok: true, skipped: check.skipped });
      continue;
    }
    try {
      await check.run();
      results.push({ name: check.name, ok: true });
    } catch (e) {
      results.push({
        name: check.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/** Every check, in order. Nothing runs until you call `run`. */
export function conformanceChecks(options: ConformanceOptions): Check[] {
  const checks: Check[] = [];
  let group = '';
  const describe = (name: string, body: () => void) => {
    const outer = group;
    group = outer ? `${outer} > ${name}` : name;
    body();
    group = outer;
  };
  const it = (name: string, run: () => Promise<void>) => {
    checks.push({ name: group ? `${group} > ${name}` : name, run });
  };

  const holdMs = (options.holdSeconds ?? 300) * 1000;
  const ctxAt = (offsetMs = 0): ProviderContext => ({
    now: new Date(options.now.getTime() + offsetMs),
  });

  /** The BookingError code a promise fails with, or null if it succeeds. */
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof BookingError) return e.code;
      throw new Error(
        `Expected a BookingError but got: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        { cause: e },
      );
    }
    return null;
  };

  async function setup() {
    const provider = await options.create();
    const venues = await provider.listVenues();
    const venue_id = options.query.venue_id ?? venues[0]?.id;
    if (!venue_id) throw new Error('The provider returned no venues; the suite needs one.');
    const query = { ...options.query, venue_id, limit: 50 };
    const search = (offsetMs = 0) => provider.searchAvailability(query, ctxAt(offsetMs));
    const hold = (
      slot: Slot,
      extra: { customer?: Customer | null; notes?: string | null; at?: number } = {},
    ) =>
      provider.createHold(
        {
          slot_id: slot.slot_id,
          expires_at: new Date(options.now.getTime() + (extra.at ?? 0) + holdMs),
          customer: extra.customer ?? null,
          notes: extra.notes ?? null,
        },
        ctxAt(extra.at ?? 0),
      );
    const confirm = (booking: Booking, offsetMs = 0) =>
      provider.confirmHold(
        {
          booking_id: booking.booking_id,
          customer: CUSTOMER,
          payment_token: options.paymentToken ?? null,
        },
        ctxAt(offsetMs),
      );
    const cancel = (booking: Booking, terms: { fee?: Money; refund?: Money } = {}) =>
      provider.cancelBooking(
        {
          booking_id: booking.booking_id,
          reason: 'conformance',
          fee: terms.fee ?? null,
          refund: terms.refund ?? null,
        },
        ctxAt(),
      );
    /** Holds the slot until the provider refuses; returns every hold it granted. */
    const fill = async (slot: Slot) => {
      const held: Booking[] = [];
      for (;;) {
        try {
          held.push(await hold(slot));
        } catch (e) {
          if (e instanceof BookingError && e.code === 'slot_unavailable') return held;
          throw e;
        }
        if (held.length > MAX_CAPACITY) {
          throw new Error(
            `Slot ${slot.slot_id} accepted more than ${MAX_CAPACITY} holds without saying slot_unavailable: it is being overbooked.`,
          );
        }
      }
    };
    const release = async (held: Booking[]) => {
      for (const b of held) await cancel(b);
    };
    return { provider, venue_id, query, search, hold, confirm, cancel, fill, release };
  }

  /**
   * Finds two slots to work with and how many bookings the first can take. The provider is left
   * empty again, so the caller can use `first.capacity` straight away.
   */
  async function slotsToUse() {
    const s = await setup();
    const first = (await s.search())[0];
    if (!first) throw new Error('options.query returned no slots; the suite needs one.');
    const held = await s.fill(first);
    if (held.length === 0)
      throw new Error('The first slot could not be held; the suite needs one that can.');
    const second = (await s.search()).find((x) => x.slot_id !== first.slot_id);
    if (!second) {
      throw new Error(
        'options.query needs a second slot at another time. Once the first slot is full, the search returned none.',
      );
    }
    await s.release(held);
    return { ...s, first, second, capacity: held.length };
  }

  {
    describe('discovery', () => {
      it('lists venues with unique ids that match the schema', async () => {
        const { provider } = await setup();
        const venues = await provider.listVenues();
        expect(venues.length).toBeGreaterThan(0);
        for (const v of venues) VenueSchema.parse(v);
        expect(new Set(venues.map((v) => v.id)).size).toBe(venues.length);
      });

      it('returns well-formed slots for the venue, party and date asked for', async () => {
        const { search, venue_id, query } = await setup();
        const slots = await search();
        expect(slots.length).toBeGreaterThan(0);
        for (const s of slots) {
          SlotSchema.parse(s);
          expect(s.venue_id).toBe(venue_id);
          expect(s.start).toMatch(OFFSET_ISO);
          expect(s.end).toMatch(OFFSET_ISO);
          expect(Date.parse(s.end)).toBeGreaterThan(Date.parse(s.start));
          expect(s.party_size.total).toBe(query.party_size.total);
        }
        expect(new Set(slots.map((s) => s.slot_id)).size).toBe(slots.length);
      });

      it('searching changes nothing', async () => {
        const { search } = await setup();
        const a = await search();
        const b = await search();
        expect(b.map((s) => s.slot_id)).toEqual(a.map((s) => s.slot_id));
      });

      it('answers the optional discovery methods in the shape the schemas promise', async () => {
        const { provider, venue_id } = await setup();
        const ctx = ctxAt();
        if (provider.listOfferings) {
          for (const o of await provider.listOfferings(venue_id, ctx)) OfferingSchema.parse(o);
        }
        if (provider.listResources) {
          for (const r of await provider.listResources(venue_id, ctx)) ResourceSchema.parse(r);
        }
        if (provider.getVenueInfo)
          VenueInfoSchema.parse(await provider.getVenueInfo(venue_id, ctx));
      });
    });

    describe('holds', () => {
      it('reserves the slot until the requested expiry', async () => {
        const { first, hold, provider } = await slotsToUse();
        const held = await hold(first);
        BookingSchema.parse(held);
        expect(held.status).toBe('held');
        expect(held.slot.slot_id).toBe(first.slot_id);
        expect(Date.parse(held.expires_at!)).toBe(options.now.getTime() + holdMs);
        expect(await provider.getBooking(held.booking_id, ctxAt())).toMatchObject({
          booking_id: held.booking_id,
          status: 'held',
        });
      });

      it('keeps the customer and notes it was given', async () => {
        const { first, hold } = await slotsToUse();
        const held = await hold(first, { customer: CUSTOMER, notes: 'window seat' });
        expect(held.customer).toMatchObject({ first_name: CUSTOMER.first_name });
        expect(held.notes).toBe('window seat');
      });

      it('stops offering a slot once all of it is held', async () => {
        const { first, fill, search } = await slotsToUse();
        await fill(first);
        expect((await search()).map((s) => s.slot_id)).not.toContain(first.slot_id);
      });

      it('refuses further holds on a full slot with slot_unavailable', async () => {
        const { first, fill, hold } = await slotsToUse();
        await fill(first);
        expect(await code(hold(first))).toBe('slot_unavailable');
      });

      it('never grants more holds than the slot has room for, however many ask at once', async () => {
        const { first, hold, capacity } = await slotsToUse();
        const results = await Promise.allSettled(
          Array.from({ length: capacity + 5 }, () => hold(first)),
        );
        const won = results.filter((r) => r.status === 'fulfilled');
        expect(won).toHaveLength(capacity);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'slot_unavailable' });
        }
      });

      it('gives each simultaneous hold its own booking id', async () => {
        const { first, hold, capacity } = await slotsToUse();
        const held = await Promise.allSettled(Array.from({ length: capacity }, () => hold(first)));
        const ids = held.flatMap((r) => (r.status === 'fulfilled' ? [r.value.booking_id] : []));
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('holds different slots independently', async () => {
        const { first, second, fill, hold } = await slotsToUse();
        await fill(first);
        await expect(hold(second)).resolves.toMatchObject({ status: 'held' });
      });

      it('rejects a slot that does not exist with a BookingError', async () => {
        const { provider } = await setup();
        const result = await code(
          provider.createHold(
            {
              slot_id: 'conformance-no-such-slot',
              expires_at: new Date(options.now.getTime() + holdMs),
              customer: null,
              notes: null,
            },
            ctxAt(),
          ),
        );
        expect(['not_found', 'slot_unavailable', 'validation_error']).toContain(result);
      });
    });

    describe('expiry', () => {
      it('stops blocking a full slot once its holds have expired', async () => {
        const { first, fill, search, hold } = await slotsToUse();
        await fill(first);
        const later = holdMs + 1000;
        expect((await search(later)).map((s) => s.slot_id)).toContain(first.slot_id);
        await expect(hold(first, { at: later })).resolves.toMatchObject({ status: 'held' });
      });

      it('reports an expired hold as expired, never as held', async () => {
        const { first, hold, provider } = await slotsToUse();
        const held = await hold(first);
        const seen = await provider.getBooking(held.booking_id, ctxAt(holdMs + 1000));
        expect(seen?.status).toBe('expired');
      });

      it('refuses to confirm an expired hold with hold_expired', async () => {
        const { first, hold, confirm } = await slotsToUse();
        const held = await hold(first);
        expect(await code(confirm(held, holdMs + 1000))).toBe('hold_expired');
      });
    });

    describe('confirming', () => {
      it('turns a hold into a confirmed booking that never expires', async () => {
        const { first, hold, confirm, provider } = await slotsToUse();
        const held = await hold(first);
        const confirmed = await confirm(held);
        BookingSchema.parse(confirmed);
        expect(confirmed).toMatchObject({ booking_id: held.booking_id, status: 'confirmed' });
        expect(confirmed.customer).toMatchObject({ first_name: CUSTOMER.first_name });
        expect(confirmed.confirmed_at).not.toBeNull();
        expect(confirmed.slot.slot_id).toBe(first.slot_id);
        const later = await provider.getBooking(held.booking_id, ctxAt(holdMs * 100));
        expect(later?.status).toBe('confirmed');
      });

      it('keeps the slot taken after the confirmed booking outlives the hold time', async () => {
        const { first, hold, confirm, capacity } = await slotsToUse();
        const held = await hold(first);
        await confirm(held);
        // Fill the rest, let every hold expire; only the confirmed booking still counts.
        const later = holdMs + 1000;
        let granted = 0;
        for (;;) {
          const r = await code(hold(first, { at: later }));
          if (r === 'slot_unavailable') break;
          if (r !== null) throw new Error(`unexpected ${r}`);
          if (++granted > MAX_CAPACITY) throw new Error('overbooked');
        }
        expect(granted).toBe(capacity - 1);
      });

      it('answers an unknown booking id with not_found', async () => {
        const { provider } = await setup();
        const result = await code(
          provider.confirmHold(
            { booking_id: 'conformance-no-such-booking', customer: CUSTOMER, payment_token: null },
            ctxAt(),
          ),
        );
        expect(result).toBe('not_found');
      });
    });

    describe('reading', () => {
      it('returns null for a booking it has never seen', async () => {
        const { provider } = await setup();
        expect(await provider.getBooking('conformance-no-such-booking', ctxAt())).toBeNull();
      });
    });

    describe('cancelling', () => {
      it('releases a hold and frees its place at once', async () => {
        const { first, fill, cancel, hold } = await slotsToUse();
        const held = await fill(first);
        expect(await code(hold(first))).toBe('slot_unavailable');
        const cancelled = await cancel(held[0]!);
        BookingSchema.parse(cancelled);
        expect(cancelled.status).toBe('cancelled');
        await expect(hold(first)).resolves.toMatchObject({ status: 'held' });
        expect(await code(hold(first))).toBe('slot_unavailable');
      });

      it('cancels a confirmed booking, records the fee and refund, and frees its place', async () => {
        const { first, fill, confirm, cancel, hold, provider } = await slotsToUse();
        const held = await fill(first);
        const booked = await confirm(held[0]!);
        const fee = { amount: 1000, currency: 'NOK' };
        const refund = { amount: 500, currency: 'NOK' };
        const cancelled = await cancel(booked, { fee, refund });
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.cancelled_at).not.toBeNull();
        expect(cancelled.cancellation).toMatchObject({ reason: 'conformance', fee, refund });
        expect((await provider.getBooking(booked.booking_id, ctxAt()))?.status).toBe('cancelled');
        await expect(hold(first)).resolves.toMatchObject({ status: 'held' });
      });

      it('cancelling twice never revives the booking or frees a second place', async () => {
        const { first, fill, cancel, hold, provider } = await slotsToUse();
        const held = await fill(first);
        await cancel(held[0]!);
        const again = await code(cancel(held[0]!));
        expect([null, 'invalid_state', 'not_found']).toContain(again);
        expect((await provider.getBooking(held[0]!.booking_id, ctxAt()))?.status).toBe('cancelled');
        await hold(first);
        expect(await code(hold(first))).toBe('slot_unavailable');
      });

      it('answers an unknown booking id with not_found', async () => {
        const { provider } = await setup();
        const result = await code(
          provider.cancelBooking(
            { booking_id: 'conformance-no-such-booking', reason: null, fee: null, refund: null },
            ctxAt(),
          ),
        );
        expect(result).toBe('not_found');
      });
    });

    describe('optional operations (tested when implemented)', () => {
      it('updates notes on a booking', async () => {
        const { first, hold, provider } = await slotsToUse();
        if (!provider.updateBooking) return;
        const held = await hold(first);
        const updated = await provider.updateBooking(
          { booking_id: held.booking_id, notes: 'updated by conformance' },
          ctxAt(),
        );
        expect(updated.notes).toBe('updated by conformance');
        expect(updated.booking_id).toBe(held.booking_id);
      });

      it('moves a confirmed booking atomically, keeping its id and freeing the old place', async () => {
        const { first, second, fill, hold, confirm, provider } = await slotsToUse();
        if (!provider.rescheduleBooking) return;
        const held = await fill(first);
        const booked = await confirm(held[0]!);
        const moved = await provider.rescheduleBooking(
          { booking_id: booked.booking_id, slot_id: second.slot_id },
          ctxAt(),
        );
        expect(moved.booking_id).toBe(booked.booking_id);
        expect(moved.status).toBe('confirmed');
        expect(moved.slot.slot_id).toBe(second.slot_id);
        // Exactly one place opened up in the old slot.
        await expect(hold(first)).resolves.toMatchObject({ status: 'held' });
        expect(await code(hold(first))).toBe('slot_unavailable');
      });

      it('leaves the booking where it was when the new slot is full', async () => {
        const { first, second, fill, confirm, provider } = await slotsToUse();
        if (!provider.rescheduleBooking) return;
        const booked = await confirm((await fill(first))[0]!);
        await fill(second);
        const result = await code(
          provider.rescheduleBooking(
            { booking_id: booked.booking_id, slot_id: second.slot_id },
            ctxAt(),
          ),
        );
        expect(result).toBe('slot_unavailable');
        const still = await provider.getBooking(booked.booking_id, ctxAt());
        expect(still?.status).toBe('confirmed');
        expect(still?.slot.slot_id).toBe(first.slot_id);
      });

      it('lists bookings made through it, newest first', async () => {
        const { first, second, hold, provider } = await slotsToUse();
        if (!provider.listBookings) return;
        const a = await hold(first);
        const b = await hold(second);
        const listed = await provider.listBookings({ limit: 50 }, ctxAt());
        const ids = listed.map((x) => x.booking_id);
        expect(ids).toContain(a.booking_id);
        expect(ids).toContain(b.booking_id);
        for (const x of listed) BookingSchema.parse(x);
        const times = listed.map((x) => Date.parse(x.created_at));
        expect([...times].sort((x, y) => y - x)).toEqual(times);
      });
    });
  }
  const unknown = Object.keys(options.skip ?? {}).filter((n) => !checks.some((c) => c.name === n));
  if (unknown.length) throw new Error(`options.skip names unknown checks: ${unknown.join(', ')}`);
  return checks.map((c) => {
    const reason = options.skip?.[c.name];
    return reason ? { ...c, skipped: reason } : c;
  });
}
