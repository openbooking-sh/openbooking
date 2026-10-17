/**
 * Concurrency fuzzing for the booking engine, written once and run against every store (memory
 * here, Postgres in packages/postgres). Two `BookingService` instances share one booking store and
 * one idempotency store, like two server processes behind a load balancer. Seeded actors race
 * holds, confirms and cancels for the same slots, and the invariants below must hold afterwards.
 * Nothing here depends on wall-clock time: a ManualClock never moves unless a test moves it, and
 * interleaving comes from seeded microtask yields.
 */
import { describe, expect, it } from 'vitest';
import {
  BookingService,
  ManualClock,
  MemoryIdempotencyStore,
  isBookingError,
  type Booking,
  type IdempotencyStore,
  type Resource,
  type Slot,
} from '@openbooking-sh/core';
import { MemoryBookingProvider } from '../src';
import type { BookingRecordStore, OfferingConfig, VenueConfig } from '../src';
import { FUZZ_TIMEOUT, forEachSeed, ticks, type Rng } from './fuzz';

export const DATE = '2026-10-14'; // a Wednesday, outside any DST change in Oslo
const NOW = '2026-10-12T08:00:00Z';
const BUFFER_MINUTES = 10;
const CUSTOMER = { first_name: 'Test', last_name: 'Person', email: 'test@example.com' };

const staff = (id: string): Resource => ({
  id,
  venue_id: 'v',
  kind: 'staff',
  name: id,
  capacity: { min: 1, max: 1 },
  tags: [id],
});

const service = (id: string, minutes: number, who?: string[]): OfferingConfig => ({
  id,
  venue_id: 'v',
  name: id,
  duration_minutes: minutes,
  price_per_person: { amount: 10000, currency: 'NOK' },
  resource_kinds: ['staff'],
  ...(who ? { resource_ids: who } : {}),
  cancellation: {
    refundability: 'refundable',
    free_until_hours_before: 24,
    late_fee_per_person: 5000,
    no_show_fee_per_person: 5000,
  },
  deposit: null,
});

/** Two staff. `cut` takes either, `colour` only kari, `trim` only ola: overlapping services contend. */
export function concurrencyVenue(): VenueConfig {
  return {
    venue: { id: 'v', name: 'Race venue', timezone: 'Europe/Oslo', currency: 'NOK' },
    currency: 'NOK',
    resources: [staff('kari'), staff('ola')],
    offerings: [service('cut', 30), service('colour', 90, ['kari']), service('trim', 30, ['ola'])],
    opening_hours: { 3: [{ open: '09:00', close: '17:00' }] },
    slot_interval_minutes: 30,
    buffer_minutes: BUFFER_MINUTES,
    min_lead_minutes: 60,
    max_days_ahead: 30,
  };
}

export interface Env {
  a: BookingService;
  b: BookingService;
  /** For inspecting the shared store. */
  providerA: MemoryBookingProvider;
  clockA: ManualClock;
  clockB: ManualClock;
}

/** What a suite needs from a storage backend: fresh, empty stores that both services share. */
export interface Backend {
  bookings: () => Promise<BookingRecordStore>;
  idempotency: (now: () => number) => Promise<IdempotencyStore>;
}

export const memoryBackend = (store: () => BookingRecordStore): Backend => ({
  bookings: async () => store(),
  idempotency: async (now) => new MemoryIdempotencyStore(now),
});

async function makeEnv(backend: Backend): Promise<Env> {
  const clockA = new ManualClock(NOW);
  const clockB = new ManualClock(NOW);
  const store = await backend.bookings();
  const idem = await backend.idempotency(() => clockA.now().getTime());
  const make = (clock: ManualClock) => {
    const provider = new MemoryBookingProvider(
      { name: 'race', venues: [concurrencyVenue()] },
      { store },
    );
    return {
      provider,
      service: new BookingService({ provider, clock, idempotencyStore: idem, holdLimit: false }),
    };
  };
  const a = make(clockA);
  const b = make(clockB);
  return { a: a.service, b: b.service, providerA: a.provider, clockA, clockB };
}

const setBoth = (env: Env, to: Date | number) => {
  env.clockA.set(to);
  env.clockB.set(to);
};

async function daySlots(env: Env, offering?: string): Promise<Slot[]> {
  return env.providerA.searchAvailability(
    {
      venue_id: 'v',
      date: DATE,
      party_size: { total: 1 },
      limit: 1000,
      ...(offering ? { offering_id: offering } : {}),
    },
    { now: env.clockA.now() },
  );
}

const startMs = (b: Booking) => new Date(b.slot.start).getTime();
const endMs = (b: Booking) => new Date(b.slot.end).getTime();
const live = (b: Booking & { resource_id: string }) =>
  b.status === 'confirmed' || b.status === 'held';

/** Two bookings on one resource whose times (plus turnover buffer) overlap. */
function overlapping(
  x: Booking & { resource_id: string },
  y: Booking & { resource_id: string },
): boolean {
  return (
    x.booking_id !== y.booking_id &&
    x.resource_id === y.resource_id &&
    startMs(x) < endMs(y) + BUFFER_MINUTES * 60_000 &&
    startMs(y) < endMs(x) + BUFFER_MINUTES * 60_000
  );
}

async function expectConsistent(env: Env, context: string): Promise<void> {
  const now = env.clockA.now();
  const all = await env.providerA.inspectBookings(now);
  const blocking = all.filter(live);
  for (let i = 0; i < blocking.length; i++) {
    for (let j = i + 1; j < blocking.length; j++) {
      expect(
        overlapping(blocking[i]!, blocking[j]!),
        `${context}: bookings ${blocking[i]!.booking_id} and ${blocking[j]!.booking_id} overlap on ${blocking[i]!.resource_id}`,
      ).toBe(false);
    }
  }
  expect(await env.providerA.findOverlaps(now), `${context}: provider.findOverlaps`).toEqual([]);

  // A live booking's time never comes back as available on its resource.
  for (const slot of await daySlots(env)) {
    const people = [slot.resource?.id, ...(slot.also_available ?? [])];
    for (const b of blocking) {
      const clash =
        new Date(slot.start).getTime() < endMs(b) + BUFFER_MINUTES * 60_000 &&
        startMs(b) < new Date(slot.end).getTime() + BUFFER_MINUTES * 60_000;
      if (clash) {
        expect(
          people,
          `${context}: ${b.booking_id} (${b.status}) reappears at ${slot.start}`,
        ).not.toContain(b.resource_id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Racing actors
// ---------------------------------------------------------------------------

interface Call {
  kind: 'hold' | 'confirm' | 'cancel';
  key: string;
  slot_id?: string;
  consent?: boolean;
  booking_id?: string;
  ok: boolean;
  code?: string;
  inactive?: boolean;
  confirmation_code?: string | null;
}

const codeOf = (e: unknown) => (isBookingError(e) ? e.code : `unexpected:${String(e)}`);

async function race(env: Env, rng: Rng, seed: number, pool: Slot[]): Promise<Call[]> {
  const calls: Call[] = [];
  const n = rng.int(8, 22);
  const keyOfActor: string[] = [];
  const svcOfActor: Array<'a' | 'b'> = [];
  const slotOfActor: Slot[] = [];
  const actors: Array<() => Promise<void>> = [];

  for (let i = 0; i < n; i++) {
    let svcName: 'a' | 'b' = rng.pick(['a', 'b'] as const);
    let slot = rng.pick(pool);
    let key = `hold-${seed}-${i}`;
    // Reuse an earlier actor's key (same instance: concurrent duplicates share one execution).
    if (i > 0 && rng.chance(0.3)) {
      const j = rng.int(0, i - 1);
      key = keyOfActor[j]!;
      svcName = svcOfActor[j]!;
      slot = rng.chance(0.5) ? slotOfActor[j]! : slot; // sometimes a different payload
    }
    keyOfActor.push(key);
    svcOfActor.push(svcName);
    slotOfActor.push(slot);
    const plan = rng.int(0, 5);
    const yields = [rng.int(0, 8), rng.int(0, 8), rng.int(0, 8)] as const;
    const other: 'a' | 'b' = svcName === 'a' ? 'b' : 'a';

    actors.push(async () => {
      const svc = env[svcName];
      await ticks(yields[0]);
      let held: Booking;
      try {
        held = await svc.hold({ slot_id: slot.slot_id, idempotency_key: key, customer: CUSTOMER });
        calls.push({
          kind: 'hold',
          key,
          slot_id: slot.slot_id,
          ok: true,
          booking_id: held.booking_id,
        });
      } catch (e) {
        calls.push({ kind: 'hold', key, slot_id: slot.slot_id, ok: false, code: codeOf(e) });
        return;
      }
      await ticks(yields[1]);
      const id = held.booking_id;

      const confirm = async (s: BookingService, ck: string, consent: boolean) => {
        try {
          const b = await s.confirm({
            booking_id: id,
            idempotency_key: ck,
            user_confirmed: consent,
            customer: CUSTOMER,
          });
          calls.push({
            kind: 'confirm',
            key: ck,
            booking_id: id,
            consent,
            ok: b.status === 'confirmed',
            confirmation_code: b.confirmation_code,
          });
        } catch (e) {
          calls.push({
            kind: 'confirm',
            key: ck,
            booking_id: id,
            consent,
            ok: false,
            code: codeOf(e),
          });
        }
      };
      const cancel = async (s: BookingService, ck: string, consent: boolean) => {
        try {
          const r = await s.cancel({
            booking_id: id,
            idempotency_key: ck,
            user_confirmed: consent,
          });
          calls.push({
            kind: 'cancel',
            key: ck,
            booking_id: id,
            consent,
            ok: r.booking.status === 'cancelled',
            inactive: r.already_inactive,
          });
        } catch (e) {
          calls.push({
            kind: 'cancel',
            key: ck,
            booking_id: id,
            consent,
            ok: false,
            code: codeOf(e),
          });
        }
      };

      switch (plan) {
        case 0:
          await confirm(svc, `confirm-${seed}-${i}`, true);
          break;
        case 1:
          await confirm(svc, `confirm-${seed}-${i}`, false);
          await ticks(yields[2]);
          await confirm(svc, `confirm-${seed}-${i}`, true); // same key: a retry once the user agreed
          break;
        case 2: // two instances confirm the same hold with different keys at once
          await Promise.all([
            confirm(svc, `confirm-${seed}-${i}-x`, true),
            confirm(env[other], `confirm-${seed}-${i}-y`, true),
          ]);
          break;
        case 3: // confirm races a consent-free release of the same hold
          await Promise.all([
            confirm(svc, `confirm-${seed}-${i}`, true),
            ticks(yields[2]).then(() => cancel(env[other], `cancel-${seed}-${i}`, false)),
          ]);
          break;
        case 4:
          await confirm(svc, `confirm-${seed}-${i}`, true);
          await ticks(yields[2]);
          await cancel(env[other], `cancel-${seed}-${i}`, true);
          break;
        default:
          await cancel(svc, `cancel-${seed}-${i}`, false);
      }
    });
  }
  await Promise.all(actors.map((a) => a()));
  return calls;
}

function expectCallsMakeSense(
  calls: Call[],
  all: Array<Booking & { resource_id: string }>,
  ctx: string,
) {
  // The same key never produces two bookings, and never for two different payloads.
  const byKey = new Map<string, Call[]>();
  for (const c of calls.filter((x) => x.kind === 'hold' && x.ok)) {
    byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  }
  for (const [key, group] of byKey) {
    expect(new Set(group.map((c) => c.booking_id)).size, `${ctx}: key ${key} booked twice`).toBe(1);
    expect(
      new Set(group.map((c) => c.slot_id)).size,
      `${ctx}: key ${key} served two payloads`,
    ).toBe(1);
  }
  const holdBookingIds = new Set(
    calls.filter((c) => c.kind === 'hold' && c.ok).map((c) => c.booking_id),
  );
  // Every stored booking came from a successful hold call (no phantom bookings).
  expect(new Set(all.map((b) => b.booking_id)), `${ctx}: stored bookings`).toEqual(holdBookingIds);

  for (const b of all) {
    const mine = calls.filter((c) => c.booking_id === b.booking_id);
    const consentedConfirm = mine.some((c) => c.kind === 'confirm' && c.consent && c.ok);
    if (b.status === 'confirmed') {
      // Consent: nothing is confirmed unless an explicit user_confirmed confirm succeeded.
      expect(consentedConfirm, `${ctx}: ${b.booking_id} confirmed without consent`).toBe(true);
      expect(b.confirmation_code, `${ctx}: confirmation code`).toBeTruthy();
    }
    // A confirm that reported success must not be silently undone by a consent-free release.
    const releasedWithoutConsent = mine.some(
      (c) => c.kind === 'cancel' && !c.consent && c.ok && !c.inactive,
    );
    const cancelledWithConsent = mine.some((c) => c.kind === 'cancel' && c.consent && c.ok);
    if (consentedConfirm && releasedWithoutConsent) {
      expect(
        cancelledWithConsent,
        `${ctx}: ${b.booking_id} was confirmed and then cancelled without the user's consent`,
      ).toBe(true);
    }
    // One confirmation code however many confirms raced.
    const codes = new Set(
      mine.filter((c) => c.kind === 'confirm' && c.ok).map((c) => c.confirmation_code),
    );
    expect(codes.size, `${ctx}: ${b.booking_id} confirmation codes`).toBeLessThanOrEqual(1);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function describeConcurrency(name: string, backend: Backend, defaultRuns: number): void {
  describe(`concurrency: ${name}`, () => {
    it(
      'racing holds, confirms and cancels never double book or confirm without consent',
      { timeout: FUZZ_TIMEOUT },
      async () => {
        await forEachSeed(
          defaultRuns,
          async (rng, seed) => {
            const env = await makeEnv(backend);
            // A small pool of starts, so overlaps and exact collisions are common.
            const pool = (await daySlots(env)).filter((s) => {
              const hhmm = s.start.slice(11, 16);
              return hhmm >= '09:00' && hhmm <= '10:30';
            });
            const calls = await race(env, rng, seed, pool);
            const ctx = `seed ${seed}`;
            const all = await env.providerA.inspectBookings(env.clockA.now());
            expectCallsMakeSense(calls, all, ctx);
            await expectConsistent(env, ctx);
          },
          name,
        );
      },
    );

    it(
      'one key sent many times at once yields one booking; another payload is a conflict',
      { timeout: FUZZ_TIMEOUT },
      async () => {
        await forEachSeed(
          Math.max(1, Math.floor(defaultRuns / 2)),
          async (rng, seed) => {
            const env = await makeEnv(backend);
            const pool = await daySlots(env, 'colour');
            const slot = rng.pick(pool);
            const other = pool.find((s) => s.slot_id !== slot.slot_id)!;
            const svc = rng.pick([env.a, env.b]);
            const key = `same-key-${seed}`;
            const sends = rng.int(4, 12);

            const results = await Promise.allSettled(
              Array.from({ length: sends }, async (_, i) => {
                await ticks(rng.int(0, 6));
                // Every third caller sends a different request under the same key.
                const target = i % 3 === 2 ? other : slot;
                return {
                  target,
                  booking: await svc.hold({
                    slot_id: target.slot_id,
                    idempotency_key: key,
                    customer: CUSTOMER,
                  }),
                };
              }),
            );
            const ok = results.filter((r) => r.status === 'fulfilled');
            const bookingIds = new Set(ok.map((r) => r.value.booking.booking_id));
            expect(bookingIds.size, 'one booking per key').toBe(1);
            // Whoever won, only callers with the winning payload succeeded; the rest were told so.
            const winner = ok[0]!.value.target.slot_id;
            expect(ok.every((r) => r.value.target.slot_id === winner)).toBe(true);
            for (const r of results) {
              if (r.status === 'rejected') expect(codeOf(r.reason)).toBe('idempotency_conflict');
            }
            expect(await env.providerA.inspectBookings(env.clockA.now())).toHaveLength(1);

            // The same key later, from the other instance: a replay of the first result.
            const later = await (svc === env.a ? env.b : env.a).hold({
              slot_id: winner,
              idempotency_key: key,
              customer: CUSTOMER,
            });
            expect(later.booking_id).toBe([...bookingIds][0]);
            await expect(
              (svc === env.a ? env.b : env.a).hold({
                slot_id: winner === slot.slot_id ? other.slot_id : slot.slot_id,
                idempotency_key: key,
                customer: CUSTOMER,
              }),
            ).rejects.toMatchObject({ code: 'idempotency_conflict' });
            expect(await env.providerA.inspectBookings(env.clockA.now())).toHaveLength(1);
          },
          name,
        );
      },
    );

    it('confirm retried on another instance with the same key replays; a changed request conflicts', async () => {
      const env = await makeEnv(backend);
      const [slot] = await daySlots(env, 'colour');
      const hold = await env.a.hold({
        slot_id: slot!.slot_id,
        idempotency_key: 'hold-seq-001',
        customer: CUSTOMER,
      });
      const first = await env.a.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-seq-1',
        user_confirmed: true,
        customer: CUSTOMER,
      });
      const replay = await env.b.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-seq-1',
        user_confirmed: true,
        customer: CUSTOMER,
      });
      expect(replay.confirmation_code).toBe(first.confirmation_code);
      await expect(
        env.b.confirm({
          booking_id: hold.booking_id,
          idempotency_key: 'confirm-seq-1',
          user_confirmed: true,
          customer: { ...CUSTOMER, first_name: 'Someone' },
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(await env.providerA.inspectBookings(env.clockA.now())).toHaveLength(1);
    });

    it(
      'a hold frees its slot exactly at expiry, and a late confirm cannot take it back',
      { timeout: FUZZ_TIMEOUT },
      async () => {
        await forEachSeed(
          Math.max(1, Math.floor(defaultRuns / 2)),
          async (rng, seed) => {
            const env = await makeEnv(backend);
            const pool = await daySlots(env, 'colour');
            const slot = rng.pick(pool);
            // A colour slot that overlaps `slot` (same kari, shifted by 0, 30 or 60 minutes).
            const rival = rng.pick(
              pool.filter(
                (s) =>
                  Math.abs(new Date(s.start).getTime() - new Date(slot.start).getTime()) <
                  100 * 60_000,
              ),
            );
            const first = await env.a.hold({
              slot_id: slot.slot_id,
              idempotency_key: `exp-hold-${seed}-1`,
              customer: CUSTOMER,
            });
            const expires = new Date(first.expires_at!).getTime();

            // One millisecond early: still held, so the rival cannot have it on either instance.
            setBoth(env, expires - 1);
            await expect(
              rng.pick([env.a, env.b]).hold({
                slot_id: rival.slot_id,
                idempotency_key: `exp-hold-${seed}-2`,
                customer: CUSTOMER,
              }),
            ).rejects.toMatchObject({ code: 'slot_unavailable' });
            expect((await env.b.getBooking(first.booking_id)).status).toBe('held');
            expect((await daySlots(env, 'colour')).map((s) => s.slot_id)).not.toContain(
              slot.slot_id,
            );

            // At the expiry instant the slot is free again and the rival wins it.
            setBoth(env, expires);
            expect((await env.b.getBooking(first.booking_id)).status).toBe('expired');
            expect((await daySlots(env, 'colour')).map((s) => s.slot_id)).toContain(slot.slot_id);
            const second = await env.b.hold({
              slot_id: rival.slot_id,
              idempotency_key: `exp-hold-${seed}-3`,
              customer: CUSTOMER,
            });

            // The first customer arrives late. Instance A's clock lags by a millisecond, so it still
            // thinks the hold is alive; the store must refuse rather than overlap the rival.
            env.clockA.set(expires - 1);
            await expect(
              env.a.confirm({
                booking_id: first.booking_id,
                idempotency_key: `exp-confirm-${seed}-1`,
                user_confirmed: true,
                customer: CUSTOMER,
              }),
            ).rejects.toMatchObject({ code: 'hold_expired' });
            setBoth(env, expires);
            const confirmed = await env.b.confirm({
              booking_id: second.booking_id,
              idempotency_key: `exp-confirm-${seed}-2`,
              user_confirmed: true,
              customer: CUSTOMER,
            });
            expect(confirmed.status).toBe('confirmed');
            await expectConsistent(env, `seed ${seed}`);
          },
          name,
        );
      },
    );

    // Known limitation, documented in PostgresIdempotencyStore: concurrent first-time calls with
    // one key are joined per process only. Across instances both run, so one key can hold twice
    // (inventory stays safe). `it.fails` flips to a failure the day this is closed, and then
    // should become a plain `it`.
    it.fails(
      'KNOWN GAP: the same key sent to two instances at the same instant holds once',
      async () => {
        const env = await makeEnv(backend);
        const [slot] = await daySlots(env, 'cut');
        const results = await Promise.all(
          [env.a, env.b].map((s) =>
            s.hold({
              slot_id: slot!.slot_id,
              idempotency_key: 'both-at-once-1',
              customer: CUSTOMER,
            }),
          ),
        );
        expect(new Set(results.map((r) => r.booking_id)).size).toBe(1);
      },
    );
  });
}
