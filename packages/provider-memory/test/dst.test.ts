/**
 * Daylight saving time: slot generation, opening and staff hours, durations, cancellation windows
 * and hold expiry on the days clocks change. Fixed cases first, then seeded fuzzing (see fuzz.ts).
 */
import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, time } from '@openbooking-sh/core';
import type { Resource, Slot } from '@openbooking-sh/core';
import { MemoryBookingProvider } from '../src';
import type { OfferingConfig, OpeningPeriod, VenueConfig } from '../src';
import { FUZZ_TIMEOUT, forEachSeed, type Rng } from './fuzz';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One zone per interesting shape: north, south, half-hour offset, 30-minute shift, west. */
const ZONES = [
  'Europe/Oslo',
  'Australia/Adelaide', // southern hemisphere, +09:30/+10:30
  'Asia/Kolkata', // half-hour offset, no DST (control)
  'Australia/Lord_Howe', // the change is 30 minutes, not an hour
  'America/New_York', // west of UTC
] as const;

const staff = (id: string): Resource => ({
  id,
  venue_id: 'v',
  kind: 'staff',
  name: id,
  capacity: { min: 1, max: 1 },
  tags: [id],
});

function offering(
  id: string,
  duration: number,
  extra: Partial<OfferingConfig> = {},
): OfferingConfig {
  return {
    id,
    venue_id: 'v',
    name: id,
    duration_minutes: duration,
    price_per_person: { amount: 10000, currency: 'EUR' },
    resource_kinds: ['staff'],
    cancellation: {
      refundability: 'refundable',
      free_until_hours_before: 24,
      late_fee_per_person: 5000,
      no_show_fee_per_person: 5000,
    },
    deposit: null,
    ...extra,
  };
}

const allWeek = (periods: OpeningPeriod[]) =>
  Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, periods]));

function venue(tz: string, over: Partial<VenueConfig> = {}): VenueConfig {
  return {
    venue: { id: 'v', name: 'DST venue', timezone: tz, currency: 'EUR' },
    currency: 'EUR',
    resources: [staff('a'), staff('b')],
    offerings: [offering('svc', 30)],
    opening_hours: allWeek([{ open: '00:00', close: '24:00' }]),
    slot_interval_minutes: 30,
    buffer_minutes: 0,
    min_lead_minutes: 0,
    max_days_ahead: 800,
    ...over,
  };
}

function setup(cfg: VenueConfig, now: Date | string) {
  const provider = new MemoryBookingProvider({ name: 'dst', venues: [cfg] });
  const clock = new ManualClock(now);
  return { provider, clock, service: new BookingService({ provider, clock }) };
}

/** All slots of a day. Goes to the provider: the service caps a search at 50 results. */
const search = (service: BookingService, date: string, offering_id?: string) =>
  service.provider.searchAvailability(
    {
      venue_id: 'v',
      date,
      party_size: { total: 1 },
      limit: 1000,
      ...(offering_id ? { offering_id } : {}),
    },
    { now: service.clock.now() },
  );

const wall = (slot: Slot) => slot.start.slice(11, 16);

// ---------------------------------------------------------------------------
// Ground truth, independent of zonedToInstant: scan real instants and read their wall time.
// ---------------------------------------------------------------------------

const wallCache = new Map<string, Map<string, Set<number>>>();

/**
 * Every wall time (`HH:MM`) that really happens on `date` in `tz`, with the UTC offsets it happens
 * at: none inside a spring-forward gap, two inside a fall-back hour. Found by walking real
 * instants in 5-minute steps and reading their wall clock, so it never touches zonedToInstant.
 */
function realWallTimes(tz: string, date: string): Map<string, Set<number>> {
  const key = `${tz}|${date}`;
  let map = wallCache.get(key);
  if (!map) {
    map = new Map();
    const mid = Date.parse(`${date}T00:00:00Z`);
    for (let t = mid - 16 * 3_600_000; t <= mid + 40 * 3_600_000; t += 300_000) {
      const at = new Date(t);
      if (time.localDate(at, tz) !== date) continue;
      const hhmm = time.localTime(at, tz);
      const offsets = map.get(hhmm) ?? new Set<number>();
      offsets.add(time.offsetMinutes(at, tz));
      map.set(hhmm, offsets);
    }
    wallCache.set(key, map);
  }
  return map;
}

const transitionCache = new Map<string, string[]>();

/** Local dates on and around every offset change of `tz` in 2026 and 2027 (plus 2 control days). */
function dstDates(tz: string): string[] {
  let dates = transitionCache.get(tz);
  if (!dates) {
    const out = new Set<string>();
    const first = Date.parse('2026-01-01T12:00:00Z');
    for (let day = 0; day < 730; day++) {
      const a = new Date(first + day * 86_400_000);
      const b = new Date(first + (day + 1) * 86_400_000);
      if (time.offsetMinutes(a, tz) !== time.offsetMinutes(b, tz)) {
        const d = time.localDate(b, tz);
        for (const n of [-1, 0, 1]) out.add(time.addDays(d, n));
        out.add(time.localDate(a, tz));
      }
    }
    if (out.size === 0) {
      out.add('2026-03-29');
      out.add('2026-10-25');
    }
    dates = [...out].sort();
    transitionCache.set(tz, dates);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Fixed cases
// ---------------------------------------------------------------------------

describe('DST fixed cases', () => {
  it('never offers a slot in the hour that does not exist (Oslo, 2026-03-29)', async () => {
    // Clocks jump 02:00 -> 03:00. The venue is open all night, so a naive grid has 02:00 and 02:30.
    const { service } = setup(venue('Europe/Oslo'), '2026-03-27T12:00:00Z');
    const slots = await search(service, '2026-03-29');
    const times = slots.map(wall);

    expect(times).not.toContain('02:00');
    expect(times).not.toContain('02:30');
    expect(times).toContain('01:30');
    expect(times).toContain('03:00');
    // 24h day minus the missing hour, 30-minute grid, 30-minute service, two staff but one slot each.
    expect(slots).toHaveLength(46);
    // No two slots at the same real instant (the missing 02:xx used to collapse onto 03:xx).
    expect(new Set(slots.map((s) => new Date(s.start).getTime())).size).toBe(slots.length);
  });

  it('offers a repeated hour once, deterministically, on the later (winter) occurrence', async () => {
    // Clocks go back 03:00 -> 02:00 on 2026-10-25, so 02:00-02:59 happens twice.
    const { service } = setup(venue('Europe/Oslo'), '2026-10-23T12:00:00Z');
    const first = await search(service, '2026-10-25');
    const again = await search(service, '2026-10-25');

    expect(first.map((s) => s.slot_id)).toEqual(again.map((s) => s.slot_id));
    const times = first.map(wall);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toHaveLength(48);
    const at = first.find((s) => wall(s) === '02:30')!;
    expect(at.start).toBe('2026-10-25T02:30:00+01:00');
  });

  it('keeps Kolkata (+05:30, no DST) on the same offset all year', async () => {
    const { service } = setup(venue('Asia/Kolkata'), '2026-03-27T12:00:00Z');
    for (const date of ['2026-03-29', '2026-10-25']) {
      const slots = await search(service, date);
      expect(slots).toHaveLength(48);
      expect(slots.every((s) => s.start.endsWith('+05:30'))).toBe(true);
    }
  });

  it('measures a service that spans the change in elapsed time', async () => {
    // 01:00 + 120 minutes on the spring-forward night ends at 04:00 local, not 03:00.
    const cfg = venue('Europe/Oslo', {
      offerings: [offering('long', 120)],
      slot_interval_minutes: 60,
    });
    const { service } = setup(cfg, '2026-03-27T12:00:00Z');
    const slot = (await search(service, '2026-03-29')).find((s) => wall(s) === '01:00')!;
    expect(slot.start).toBe('2026-03-29T01:00:00+01:00');
    expect(slot.end).toBe('2026-03-29T04:00:00+02:00');
    expect(new Date(slot.end).getTime() - new Date(slot.start).getTime()).toBe(120 * 60_000);
  });

  it('computes free cancellation across the change with the right offset', async () => {
    // Slot Monday 2026-03-30 10:00 CEST (+02:00); 48h before is Saturday 09:00 CET (+01:00)... elapsed
    // hours, so it is Saturday 09:00 +01:00 only if the clocks did not change in between: they did.
    const cfg = venue('Europe/Oslo', {
      offerings: [
        offering('x', 30, {
          cancellation: {
            refundability: 'refundable',
            free_until_hours_before: 48,
            late_fee_per_person: 100,
            no_show_fee_per_person: 100,
          },
        }),
      ],
    });
    const { service } = setup(cfg, '2026-03-27T06:00:00Z');
    const slot = (await search(service, '2026-03-30')).find((s) => wall(s) === '10:00')!;
    const until = slot.cancellation_policy.free_cancellation_until!;
    expect(new Date(until).getTime()).toBe(new Date(slot.start).getTime() - 48 * 3_600_000);
    expect(until).toBe('2026-03-28T09:00:00+01:00');
  });
});

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

function randomPeriods(rng: Rng): OpeningPeriod[] {
  const hhmm = (m: number) => (m >= 1440 ? '24:00' : time.timeOfMinutes(m));
  const periods: OpeningPeriod[] = [];
  // Often cover the small hours, where every zone here changes its clocks.
  const open = rng.chance(0.6) ? rng.pick([0, 60, 90, 120, 150]) : rng.int(0, 40) * 30;
  const close = Math.min(1440, open + rng.int(2, 48) * 30);
  periods.push({ open: hhmm(open), close: hhmm(close) });
  if (close <= 1260 && rng.chance(0.3)) {
    const open2 = close + rng.int(1, 4) * 30;
    if (open2 < 1440) periods.push({ open: hhmm(open2), close: hhmm(Math.min(1440, open2 + 120)) });
  }
  return periods;
}

function randomVenue(rng: Rng, tz: string): VenueConfig {
  const interval = rng.pick([15, 20, 30, 60]);
  const staffHours: Record<number, OpeningPeriod[]> = {};
  for (let d = 0; d < 7; d++) if (rng.chance(0.8)) staffHours[d] = randomPeriods(rng);
  return venue(tz, {
    resources: [staff('a'), staff('b')],
    offerings: [
      offering('s1', rng.pick([15, 30, 45, 60, 90])),
      offering('s2', rng.pick([60, 120, 180, 240]), { resource_ids: ['a'] }),
      offering('s3', rng.pick([20, 30, 60]), {
        cancellation: {
          refundability: 'refundable',
          free_until_hours_before: rng.pick([2, 24, 48]),
          late_fee_per_person: 1000,
          no_show_fee_per_person: 1000,
        },
      }),
    ],
    opening_hours: Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6].map((d) => [d, rng.chance(0.9) ? randomPeriods(rng) : []]),
    ),
    schedules: { b: { hours: staffHours } },
    slot_interval_minutes: interval,
    buffer_minutes: rng.pick([0, 10, 15]),
  });
}

/** Wall-clock rule the provider promises: start and start + duration fit one period. */
const fits = (periods: OpeningPeriod[] | undefined, startMin: number, dur: number) =>
  (periods ?? []).some((p) => {
    const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
    return startMin >= time.minutesOfDay(p.open) && startMin + dur <= close;
  });

function expectedWalls(cfg: VenueConfig, date: string, o: OfferingConfig): string[] {
  const tz = cfg.venue.timezone;
  const weekday = time.weekdayOfDate(date);
  const opening = cfg.opening_hours[weekday] ?? [];
  const real = realWallTimes(tz, date);
  const out: string[] = [];
  for (const p of opening) {
    const open = time.minutesOfDay(p.open);
    const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
    for (let m = open; m < close; m += cfg.slot_interval_minutes) {
      const hhmm = time.timeOfMinutes(m);
      if (!real.has(hhmm) || !fits(opening, m, o.duration_minutes)) continue;
      const people = cfg.resources.filter((r) => !o.resource_ids || o.resource_ids.includes(r.id));
      const works = people.some((r) => {
        const hours = cfg.schedules?.[r.id]?.hours;
        return !hours || fits(hours[weekday], m, o.duration_minutes);
      });
      if (works) out.push(hhmm);
    }
  }
  return out;
}

describe('DST fuzz', () => {
  it(
    'slot generation matches the clock on every change day, in every zone',
    { timeout: FUZZ_TIMEOUT },
    async () => {
      await forEachSeed(
        4,
        async (rng) => {
          for (const tz of ZONES) {
            const cfg = randomVenue(rng, tz);
            const dates = dstDates(tz);
            const date = rng.pick(dates);
            const ctx = `${tz} ${date}`;
            const { service } = setup(
              cfg,
              new Date(Date.parse(`${date}T12:00:00Z`) - 2 * 86_400_000),
            );

            for (const o of cfg.offerings) {
              const slots = await search(service, date, o.id);
              const walls = slots.map(wall);

              // Exactly the wall times that exist, no more (nonexistent hour) and no fewer.
              expect(walls, `${ctx} ${o.id} wall times`).toEqual(expectedWalls(cfg, date, o));
              // One slot per wall time and per instant: no duplicates, ever.
              expect(new Set(walls).size, `${ctx} duplicate wall time`).toBe(walls.length);
              expect(
                new Set(slots.map((s) => new Date(s.start).getTime())).size,
                `${ctx} duplicate instant`,
              ).toBe(slots.length);

              for (const s of slots) {
                const start = new Date(s.start);
                const end = new Date(s.end);
                // ISO strings carry the venue offset valid on that date and round-trip exactly.
                expect(time.formatInZone(start, tz), `${ctx} start round trip`).toBe(s.start);
                expect(time.formatInZone(end, tz), `${ctx} end round trip`).toBe(s.end);
                expect(s.start.slice(0, 10), `${ctx} slot on the asked date`).toBe(date);
                // Duration is elapsed time, whatever the wall clock did meanwhile.
                expect(end.getTime() - start.getTime(), `${ctx} elapsed duration`).toBe(
                  o.duration_minutes * 60_000,
                );
                // A repeated wall time is offered once, as one of the two moments it really is
                // (which one is zone dependent today; the Oslo case above pins that down).
                expect(
                  realWallTimes(tz, date).get(wall(s))?.has(time.offsetMinutes(start, tz)),
                  `${ctx} ${wall(s)} is a real moment`,
                ).toBe(true);
                // Free cancellation is N elapsed hours before the start, in the offset of that moment.
                const until = s.cancellation_policy.free_cancellation_until!;
                const hours = (s.cancellation_policy.description.match(/\((\d+) hours before\)/) ??
                  [])[1];
                expect(new Date(until).getTime(), `${ctx} free until`).toBe(
                  start.getTime() - Number(hours) * 3_600_000,
                );
                expect(time.formatInZone(new Date(until), tz), `${ctx} free until offset`).toBe(
                  until,
                );
              }
            }
          }
        },
        'dst slots',
      );
    },
  );

  it(
    'hold expiry and free-cancellation deadlines are exact across a change',
    { timeout: FUZZ_TIMEOUT },
    async () => {
      await forEachSeed(
        4,
        async (rng) => {
          const tz = rng.pick(ZONES.filter((z) => z !== 'Asia/Kolkata'));
          const date = rng.pick(dstDates(tz));
          const cfg = randomVenue(rng, tz);
          // "Now" is a few hours before midnight of the change day, so holds and the 2h/24h/48h
          // windows straddle the change.
          const dayStart = time.zonedToInstant(date, '00:00', tz).getTime();
          const now = new Date(dayStart - rng.int(1, 60) * 60_000);
          const { service, clock, provider } = setup(cfg, now);
          const o = cfg.offerings[0]!;
          const slots = (await search(service, date, o.id)).filter(
            (s) => new Date(s.start).getTime() > now.getTime(),
          );
          if (!slots.length) return;
          const slot = rng.pick(slots);

          const hold = await service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-001' });
          const expires = new Date(hold.expires_at!);
          expect(expires.getTime() - now.getTime()).toBe(service.holdTtlSeconds * 1000);

          // One millisecond before expiry the slot is still held: nobody else can take it.
          clock.set(expires.getTime() - 1);
          const during = await search(service, date, o.id);
          expect(
            during.some((s) => s.start === slot.start && s.resource?.id === hold.slot.resource?.id),
          ).toBe(false);
          expect((await service.getBooking(hold.booking_id)).status).toBe('held');

          // At the expiry instant the hold lets go: confirm fails, the slot is bookable again.
          clock.set(expires);
          expect((await service.getBooking(hold.booking_id)).status).toBe('expired');
          await expect(
            service.confirm({
              booking_id: hold.booking_id,
              idempotency_key: 'conf-000',
              user_confirmed: true,
              customer: { first_name: 'A', last_name: 'B', email: 'a@example.com' },
            }),
          ).rejects.toMatchObject({ code: 'hold_expired' });
          const rehold = await service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-002' });
          expect(rehold.slot.start).toBe(slot.start);

          // Confirm, then cancel one millisecond either side of the free-cancellation deadline.
          const confirmed = await service.confirm({
            booking_id: rehold.booking_id,
            idempotency_key: 'conf-001',
            user_confirmed: true,
            customer: { first_name: 'A', last_name: 'B', email: 'a@example.com' },
          });
          const until = new Date(confirmed.slot.cancellation_policy.free_cancellation_until!);
          if (until.getTime() > clock.now().getTime()) {
            clock.set(until.getTime() - 1);
            // A second booking so both sides of the boundary can be tried.
            const free = await service.cancel({
              booking_id: confirmed.booking_id,
              idempotency_key: 'canc-001',
              user_confirmed: true,
            });
            expect(free.booking.cancellation?.fee ?? null).toBeNull();
          }
          expect(await provider.findOverlaps(clock.now())).toEqual([]);
        },
        'dst hold and cancel',
      );
    },
  );

  it('charges the late fee from the deadline instant on', { timeout: FUZZ_TIMEOUT }, async () => {
    await forEachSeed(
      4,
      async (rng) => {
        const tz = rng.pick(ZONES.filter((z) => z !== 'Asia/Kolkata'));
        const date = rng.pick(dstDates(tz));
        const cfg = randomVenue(rng, tz);
        const dayStart = time.zonedToInstant(date, '00:00', tz).getTime();
        const { service, clock } = setup(cfg, new Date(dayStart - 3 * 86_400_000));
        const o = cfg.offerings[2]!;
        const slots = await search(service, date, o.id);
        if (!slots.length) return;
        const slot = rng.pick(slots);
        const hold = await service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-001' });
        const confirmed = await service.confirm({
          booking_id: hold.booking_id,
          idempotency_key: 'conf-001',
          user_confirmed: true,
          customer: { first_name: 'A', last_name: 'B', email: 'a@example.com' },
        });
        const until = new Date(confirmed.slot.cancellation_policy.free_cancellation_until!);
        clock.set(until); // exactly at the deadline: no longer free
        const late = await service.cancel({
          booking_id: confirmed.booking_id,
          idempotency_key: 'canc-001',
          user_confirmed: true,
        });
        expect(late.booking.cancellation?.fee?.amount).toBe(1000);
      },
      'dst late fee',
    );
  });
});
