import { randomUUID } from 'node:crypto';
import {
  BookingError,
  time,
  type AvailabilityQuery,
  type Booking,
  type BookingProvider,
  type CancelBookingRequest,
  type RescheduleBookingRequest,
  type CancellationPolicy,
  type ConfirmHoldRequest,
  type CreateHoldRequest,
  type DepositTerms,
  type Money,
  type ProviderContext,
  type Offering,
  type Resource,
  type Slot,
  type UpdateBookingRequest,
  type Venue,
  type VenueInfo,
  WEEKDAYS,
} from '@openbooking-sh/core';
import {
  durationFor,
  type MemoryProviderConfig,
  type OfferingConfig,
  type ServicePeriod,
  type TableCombination,
  type VenueConfig,
} from './config';
import {
  MemoryBookingStore,
  isBlocking,
  resourcesOf,
  type BookingRecord,
  type BookingListQuery,
  type BookingRecordStore,
  type GuestCap,
} from './store';

export interface MemoryProviderOptions {
  /** Where bookings live. Defaults to an in-process Map; use a Postgres store in production. */
  store?: BookingRecordStore;
  /**
   * Busy time from outside OpenBooking (e.g. the staff member's Google Calendar). Busy resources
   * are hidden from search and refused on hold. Throwing fails the call with a retryable error.
   */
  busy?: BusySource;
}

/** A resource that is unavailable for reasons the store doesn't know about. */
export interface BusyInterval {
  resource_id: string;
  start_ms: number;
  end_ms: number;
}

export type BusySource = (query: {
  venue_id: string;
  resource_ids: string[];
  from_ms: number;
  to_ms: number;
  now: Date;
}) => Promise<BusyInterval[]>;

/** What a slot_id encodes. Opaque to agents; base64url JSON. */
interface SlotKey {
  v: string; // venue id
  o: string; // offering id
  s: string; // start instant (UTC ISO)
  p: number; // party size total
  t?: string[]; // required resource tags
}

/**
 * Reference BookingProvider driven by an in-code catalog (venues, services, staff, opening hours,
 * rules). Bookings go to a pluggable {@link BookingRecordStore}: memory by default, Postgres via
 * `@openbooking-sh/postgres`. Atomic check-and-reserve is the store's job (`insertIfFree`), so two
 * overlapping holds can never both succeed with either store.
 */
export class MemoryBookingProvider implements BookingProvider {
  readonly info: { name: string; description?: string };
  readonly #venues: Map<string, VenueConfig>;
  readonly #store: BookingRecordStore;
  readonly #busy: BusySource | undefined;

  constructor(config: MemoryProviderConfig, options: MemoryProviderOptions = {}) {
    this.#store = options.store ?? new MemoryBookingStore();
    this.#busy = options.busy;
    this.info = {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
    };
    this.#venues = new Map(config.venues.map((v) => [v.venue.id, v]));
    for (const v of config.venues) {
      validateSchedules(v);
      validateOfferings(v);
      validateService(v);
      validateCombinations(v);
    }
  }

  async listVenues(): Promise<Venue[]> {
    return [...this.#venues.values()].map((v) => v.venue);
  }

  async searchAvailability(
    query: AvailabilityQuery & { venue_id: string },
    ctx: ProviderContext,
  ): Promise<Slot[]> {
    const cfg = this.#venue(query.venue_id);
    const party = query.party_size.total;
    const maxCapacity = Math.max(
      ...cfg.resources.map((r) => r.capacity.max),
      ...(cfg.table_combinations ?? []).map((c) => c.max_party_size),
    );
    if (party > maxCapacity) {
      throw new BookingError(
        'party_size_unsupported',
        `${cfg.venue.name} can seat at most ${maxCapacity} guests per online booking.`,
        {
          suggested_next_action: `Tell the user that groups larger than ${maxCapacity} must contact the venue${
            cfg.venue.phone_number ? ` at ${cfg.venue.phone_number}` : ''
          }.`,
        },
      );
    }
    if (query.offering_id && !cfg.offerings.some((o) => o.id === query.offering_id)) {
      throw new BookingError('not_found', `Unknown offering_id "${query.offering_id}".`, {
        suggested_next_action: `Use one of: ${cfg.offerings.map((o) => `${o.id} (${o.name})`).join(', ')}, or omit offering_id.`,
      });
    }

    const slots: Slot[] = [];
    const offerings = cfg.offerings.filter((o) => !query.offering_id || o.id === query.offering_id);
    for (const tag of query.tags ?? []) {
      if (!cfg.resources.some((x) => matchesTag(x, tag))) {
        const people = cfg.resources.filter(isPerson).map((x) => x.name);
        const features = [...new Set(cfg.resources.flatMap((x) => x.tags))].filter(
          (t) => !people.some((n) => n.toLowerCase() === t.toLowerCase()),
        );
        throw new BookingError(
          'not_found',
          `${cfg.venue.name} has no staff member or option called "${tag}".`,
          {
            suggested_next_action: `Use one of: ${[...people, ...features].join(', ') || '(none)'}, or search without it.`,
          },
        );
      }
    }
    const starts = this.#candidateStarts(cfg, query.date, ctx.now);
    if (!starts.length) return slots;
    // One read for the whole day; the per-slot checks below run against this snapshot.
    const longest =
      Math.max(...offerings.map((o) => durationFor(o, party)), 0) + cfg.buffer_minutes;
    let fromMs = starts[0]!.getTime();
    let toMs = starts[starts.length - 1]!.getTime() + longest * 60_000;
    if (hasCaps(cfg)) {
      // Guest caps count bookings by start time, so read the whole local day.
      fromMs = Math.min(
        fromMs,
        time.zonedToInstant(query.date, '00:00', cfg.venue.timezone).getTime(),
      );
      toMs = Math.max(
        toMs,
        time.zonedToInstant(time.addDays(query.date, 1), '00:00', cfg.venue.timezone).getTime(),
      );
    }
    const [booked, busy] = await Promise.all([
      this.#store.listBlocking(cfg.venue.id, fromMs, toMs, ctx.now),
      this.#busyIn(cfg, fromMs, toMs, ctx.now),
    ]);
    // A joined booking blocks each of its tables, so it is listed once per table.
    const blocking: BusyInterval[] = [
      ...booked.flatMap((r) =>
        resourcesOf(r).map((id) => ({ resource_id: id, start_ms: r.start_ms, end_ms: r.end_ms })),
      ),
      ...busy,
      ...timeOff(cfg, fromMs, toMs),
    ];
    for (const start of starts) {
      const local = time.localTime(start, cfg.venue.timezone);

      if (query.time_from && local < query.time_from) continue;
      if (query.time_to && local > query.time_to) continue;
      for (const offering of offerings) {
        if (!this.#offeringAllowed(cfg, offering, query.date, local, party)) continue;
        // Never offer what createHold would refuse for guest limits.
        if (guestCapHit(this.#capsFor(cfg, query.date, local), party, booked)) continue;
        const duration = durationFor(offering, party);
        // One table when any fits, else joined tables: createHold tries them in the same order.
        const free = this.#placements(cfg, offering, party, query.tags ?? []).filter((p) =>
          placementFree(cfg, p, blocking, start, query.date, local, duration, offering, party),
        );
        const placement = free[0];
        if (!placement) continue;
        const resource = placement.resources[0]!;
        const slot = this.#slot(cfg, offering, start, party, placement, {
          v: cfg.venue.id,
          o: offering.id,
          s: start.toISOString(),
          p: party,
          ...(query.tags?.length ? { t: query.tags } : {}),
        });
        // Staff-style resources: say who else is free, so agents can offer a choice.
        const others = free
          .slice(1)
          .filter((p) => p.resources.length === 1)
          .map((p) => p.resources[0]!)
          .filter(isPerson)
          .map((x) => x.name);
        slots.push(
          others.length && isPerson(resource) ? { ...slot, also_available: others } : slot,
        );
      }
    }
    return slots;
  }

  async createHold(req: CreateHoldRequest, ctx: ProviderContext): Promise<Booking> {
    const key = decodeSlotId(req.slot_id);
    const cfg = this.#venue(key.v);
    const offering = cfg.offerings.find((o) => o.id === key.o);
    const start = new Date(key.s);
    if (!offering || Number.isNaN(start.getTime())) throw invalidSlot();

    const date = time.localDate(start, cfg.venue.timezone);
    const local = time.localTime(start, cfg.venue.timezone);
    const bookable =
      this.#candidateStarts(cfg, date, ctx.now).some((s) => s.getTime() === start.getTime()) &&
      this.#offeringAllowed(cfg, offering, date, local, key.p);
    if (!bookable) {
      throw new BookingError(
        'slot_unavailable',
        'This slot is no longer bookable (in the past or outside opening hours).',
      );
    }
    const duration = durationFor(offering, key.p);
    const end = endOf(cfg, offering, start, key.p);
    const caps = this.#capsFor(cfg, date, local);
    // Early, readable refusal; the store re-checks atomically below, which is what holds in a race.
    await this.#assertGuestRoom(cfg, caps, key.p, date, local, ctx.now);

    const now = ctx.now.toISOString();
    const bookingId = `bk_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const busy = [
      ...(await this.#busyIn(cfg, start.getTime(), end, ctx.now)),
      ...timeOff(cfg, start.getTime(), end),
    ];
    // Best fit first; the store's atomic insert decides, so a lost race moves on to the next one.
    for (const placement of this.#placements(cfg, offering, key.p, key.t ?? [])) {
      if (!placementFree(cfg, placement, busy, start, date, local, duration, offering, key.p)) {
        continue;
      }
      const slot = this.#slot(cfg, offering, start, key.p, placement, key, req.slot_id);
      const booking: Booking = {
        booking_id: bookingId,
        status: 'held',
        venue_id: cfg.venue.id,
        slot,
        customer: req.customer,
        notes: req.notes,
        expires_at: req.expires_at.toISOString(),
        confirmation_code: null,
        payment: paymentFor(slot.deposit),
        cancellation: null,
        created_at: now,
        updated_at: now,
        confirmed_at: null,
        cancelled_at: null,
      };
      const record: BookingRecord = {
        booking,
        ...recordResources(placement),
        start_ms: start.getTime(),
        end_ms: end + placement.extraBufferMs,
        ...(caps.length ? { caps: caps.map(toStoreCap) } : {}),
      };
      if (await this.#store.insertIfFree(record, ctx.now)) return booking;
    }
    // The insert also fails when guests filled the window since the check above.
    await this.#assertGuestRoom(cfg, caps, key.p, date, local, ctx.now);
    throw new BookingError('slot_unavailable', `The ${local} slot on ${date} was just taken.`);
  }

  async confirmHold(req: ConfirmHoldRequest, ctx: ProviderContext): Promise<Booking> {
    return this.#update(req.booking_id, ctx, (b) => {
      if (b.status === 'expired') {
        throw new BookingError('hold_expired', `The hold expired at ${b.expires_at}.`);
      }
      if (b.status !== 'held') {
        throw new BookingError('invalid_state', `Booking is ${b.status}, not held.`);
      }

      let payment = b.payment;
      const deposit = b.slot.deposit;
      if (deposit?.due === 'at_confirmation') {
        // Demo payment rule: tokens starting with "tok_" succeed, except "tok_fail…".
        // "manual:…" marks a deposit staff collected in person (Studio bookings).
        const token = req.payment_token ?? '';
        if (req.payment) {
          // The engine already checked this deposit with a payment provider.
          payment = {
            status: 'paid',
            amount: req.payment.amount,
            reference: req.payment.reference,
          };
        } else if (token.startsWith('manual:')) {
          payment = { status: 'paid', amount: deposit.amount, reference: token };
        } else if (!token.startsWith('tok_') || token.startsWith('tok_fail')) {
          throw new BookingError('payment_failed', 'The deposit payment was declined.', {
            suggested_next_action:
              'Ask the user for another payment method. (Demo: use a token starting with "tok_", e.g. "tok_visa".)',
          });
        } else {
          payment = {
            status: 'paid',
            amount: deposit.amount,
            reference: `pay_${token.slice(4, 16)}`,
          };
        }
      }

      const at = ctx.now.toISOString();
      return {
        ...b,
        status: 'confirmed',
        customer: req.customer,
        expires_at: null,
        payment,
        confirmation_code: randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase(),
        confirmed_at: at,
        updated_at: at,
      };
    });
  }

  async listOfferings(venueId: string): Promise<Offering[]> {
    return this.#venue(venueId).offerings.map((o) => ({
      id: o.id,
      venue_id: o.venue_id,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
      duration_minutes: o.duration_minutes,
      price_per_person: o.price_per_person,
    }));
  }

  async getVenueInfo(venueId: string): Promise<VenueInfo> {
    const cfg = this.#venue(venueId);
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    return {
      opening_hours: Object.fromEntries(
        WEEKDAYS.map((d) => [d, (cfg.opening_hours[days.indexOf(d)] ?? []).map((p) => ({ ...p }))]),
      ) as VenueInfo['opening_hours'],
      closed_dates: [...(cfg.closed_dates ?? [])],
      staff_hours: Object.fromEntries(
        Object.entries(cfg.schedules ?? {})
          .filter(([, s]) => s.hours)
          .map(([id, s]) => [
            id,
            Object.fromEntries(
              WEEKDAYS.map((d) => [d, (s.hours![days.indexOf(d)] ?? []).map((p) => ({ ...p }))]),
            ) as VenueInfo['opening_hours'],
          ]),
      ),
      min_lead_minutes: cfg.min_lead_minutes,
      max_days_ahead: cfg.max_days_ahead,
    };
  }

  async listResources(venueId: string): Promise<Resource[]> {
    return structuredClone(this.#venue(venueId).resources);
  }

  async getBooking(bookingId: string, ctx: ProviderContext): Promise<Booking | null> {
    return (await this.#store.get(bookingId, ctx.now))?.booking ?? null;
  }

  async updateBooking(req: UpdateBookingRequest, ctx: ProviderContext): Promise<Booking> {
    return this.#update(req.booking_id, ctx, (b) => ({
      ...b,
      ...(req.customer ? { customer: req.customer } : {}),
      ...(req.notes !== undefined ? { notes: req.notes } : {}),
      updated_at: ctx.now.toISOString(),
    }));
  }

  async rescheduleBooking(req: RescheduleBookingRequest, ctx: ProviderContext): Promise<Booking> {
    const key = decodeSlotId(req.slot_id);
    const cfg = this.#venue(key.v);
    const offering = cfg.offerings.find((o) => o.id === key.o);
    const start = new Date(key.s);
    if (!offering || Number.isNaN(start.getTime())) throw invalidSlot();
    const date = time.localDate(start, cfg.venue.timezone);
    const local = time.localTime(start, cfg.venue.timezone);
    const duration = durationFor(offering, key.p);
    const end = endOf(cfg, offering, start, key.p);
    const caps = this.#capsFor(cfg, date, local);

    // A booking changed by someone else between our read and the store's lock is re-read, so the
    // move never overwrites a newer version.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = (await this.#store.get(req.booking_id, ctx.now))?.booking;
      if (!current) throw new BookingError('not_found', `No booking with id "${req.booking_id}".`);
      if (
        key.v !== current.venue_id ||
        key.o !== current.slot.offering.id ||
        key.p !== current.slot.party_size.total
      ) {
        throw new BookingError(
          'validation_error',
          'The new time must be for the same venue, service and party size.',
          {
            suggested_next_action:
              'Search availability with the same service and party size. To change the service, cancel and book again.',
          },
        );
      }
      const bookable =
        this.#candidateStarts(cfg, date, ctx.now).some((s) => s.getTime() === start.getTime()) &&
        this.#offeringAllowed(cfg, offering, date, local, key.p);
      if (!bookable) {
        throw new BookingError(
          'slot_unavailable',
          'That time is not bookable (in the past or outside opening hours).',
        );
      }
      await this.#assertGuestRoom(cfg, caps, key.p, date, local, ctx.now, req.booking_id);
      const busy = [
        ...(await this.#busyIn(cfg, start.getTime(), end, ctx.now)),
        ...timeOff(cfg, start.getTime(), end),
      ];
      let changed = false;
      for (const placement of this.#placements(cfg, offering, key.p, key.t ?? [])) {
        if (!placementFree(cfg, placement, busy, start, date, local, duration, offering, key.p)) {
          continue;
        }
        const booking: Booking = {
          ...current,
          slot: this.#slot(cfg, offering, start, key.p, placement, key, req.slot_id),
          updated_at: ctx.now.toISOString(),
        };
        try {
          const moved = await this.#store.move(
            {
              booking,
              ...recordResources(placement),
              start_ms: start.getTime(),
              end_ms: end + placement.extraBufferMs,
              ...(caps.length ? { caps: caps.map(toStoreCap) } : {}),
            },
            ctx.now,
            (b) => {
              if (b.status !== 'confirmed') {
                throw new BookingError('invalid_state', `Booking is ${b.status}, not confirmed.`);
              }
              if (b.updated_at !== current.updated_at) throw STALE;
            },
          );
          if (moved) return booking;
        } catch (e) {
          if (e !== STALE) throw e;
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    await this.#assertGuestRoom(cfg, caps, key.p, date, local, ctx.now, req.booking_id);
    throw new BookingError('slot_unavailable', `The ${local} slot on ${date} was just taken.`);
  }

  async cancelBooking(req: CancelBookingRequest, ctx: ProviderContext): Promise<Booking> {
    const at = ctx.now.toISOString();
    return this.#update(req.booking_id, ctx, (b) => {
      if (req.release_hold && b.status === 'confirmed') {
        throw new BookingError('invalid_state', 'The booking was confirmed in the meantime.', {
          suggested_next_action:
            'Fetch the booking again. To cancel a confirmed booking, ask the user and call cancel_booking with user_confirmed=true.',
        });
      }
      return {
        ...b,
        status: 'cancelled',
        expires_at: null,
        cancelled_at: at,
        updated_at: at,
        cancellation: { reason: req.reason, fee: req.fee, refund: req.refund },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Introspection (tests, benchmark)
  // ---------------------------------------------------------------------------

  async listBookings(query: BookingListQuery, ctx: ProviderContext): Promise<Booking[]> {
    return (await this.#store.list(query, ctx.now)).map((r) => r.booking);
  }

  /** All bookings with their internal resource assignment (tests, benchmark). */
  async inspectBookings(
    now: Date,
  ): Promise<Array<Booking & { resource_id: string; extra_resource_ids: string[] }>> {
    return (await this.#store.list({ limit: 1_000_000 }, now)).map((r) => ({
      ...r.booking,
      resource_id: r.resource_id,
      extra_resource_ids: r.extra_resource_ids ?? [],
    }));
  }

  /** Pairs of active bookings that overlap on a shared resource. Should always be empty. */
  async findOverlaps(now: Date): Promise<Array<[string, string]>> {
    const active = (await this.#store.list({ limit: 1_000_000 }, now)).filter((r) =>
      isBlocking(r.booking, now),
    );
    const out: Array<[string, string]> = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!;
        const b = active[j]!;
        const mine = new Set(resourcesOf(a));
        if (
          resourcesOf(b).some((id) => mine.has(id)) &&
          a.start_ms < b.end_ms &&
          b.start_ms < a.end_ms
        ) {
          out.push([a.booking.booking_id, b.booking.booking_id]);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  #venue(id: string): VenueConfig {
    const v = this.#venues.get(id);
    if (!v) throw new BookingError('not_found', `Unknown venue "${id}".`);
    return v;
  }

  async #busyIn(cfg: VenueConfig, fromMs: number, toMs: number, now: Date) {
    if (!this.#busy) return [];
    try {
      return await this.#busy({
        venue_id: cfg.venue.id,
        resource_ids: cfg.resources.map((r) => r.id),
        from_ms: fromMs,
        to_ms: toMs,
        now,
      });
    } catch (e) {
      // Fail closed: without the outside calendar we can't promise the time is free.
      throw new BookingError('provider_error', "Couldn't check the business calendar right now.", {
        cause: e,
      });
    }
  }

  async #update(id: string, ctx: ProviderContext, fn: (b: Booking) => Booking): Promise<Booking> {
    const b = await this.#store.update(id, ctx.now, fn);
    if (!b) throw new BookingError('not_found', `No booking with id "${id}".`);
    return b;
  }

  /** Every start instant on `date` within opening hours that fits the shortest offering. */
  #candidateStarts(cfg: VenueConfig, date: string, now: Date): Date[] {
    if (cfg.closed_dates?.includes(date)) return [];
    const today = time.localDate(now, cfg.venue.timezone);
    if (date < today || date > time.addDays(today, cfg.max_days_ahead)) return [];
    const earliest = now.getTime() + cfg.min_lead_minutes * 60_000;
    const out: Date[] = [];
    for (const m of this.#wallMinutes(cfg, date)) {
      const wall = time.timeOfMinutes(m);
      const start = time.zonedToInstant(date, wall, cfg.venue.timezone);
      // A wall time inside a spring-forward gap (02:30 on the night clocks jump to 03:00) does
      // not exist: zonedToInstant lands on a real instant an hour away, which is another
      // slot's start, so skipping it is what keeps every start unique.
      if (
        time.localDate(start, cfg.venue.timezone) !== date ||
        time.localTime(start, cfg.venue.timezone) !== wall
      ) {
        continue;
      }
      if (start.getTime() >= earliest) out.push(start);
    }
    return out;
  }

  /** Start times (minutes since local midnight) the venue offers on `date`, ascending. */
  #wallMinutes(cfg: VenueConfig, date: string): number[] {
    const weekday = time.weekdayOfDate(date);
    const shifts = (cfg.service_periods ?? []).filter(
      (p) => !p.weekdays || p.weekdays.includes(weekday),
    );
    const out = new Set<number>();
    for (const p of cfg.opening_hours[weekday] ?? []) {
      const open = time.minutesOfDay(p.open);
      const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
      if (!cfg.service_periods) {
        for (let m = open; m < close; m += cfg.slot_interval_minutes) out.add(m);
        continue;
      }
      for (const sp of shifts) {
        if (sp.seatings) {
          for (const t of sp.seatings) {
            const m = time.minutesOfDay(t);
            if (m >= open && m < close) out.add(m);
          }
          continue;
        }
        const from = time.minutesOfDay(sp.open);
        const to = sp.close === '24:00' ? 1440 : time.minutesOfDay(sp.close);
        for (let m = open; m < close; m += cfg.slot_interval_minutes) {
          if (m >= from && m < to) out.add(m);
        }
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /** The service period a start on `date` at `local` belongs to, if the venue has any. */
  #periodAt(cfg: VenueConfig, date: string, local: string): ServicePeriod | undefined {
    const weekday = time.weekdayOfDate(date);
    return (cfg.service_periods ?? []).find(
      (p) =>
        (!p.weekdays || p.weekdays.includes(weekday)) &&
        local >= p.open &&
        (p.close === '24:00' || local < p.close) &&
        (!p.seatings || p.seatings.includes(local)),
    );
  }

  /** The guest limits a start at `local` falls under (pacing window, walk-in reserve). */
  #capsFor(cfg: VenueConfig, date: string, local: string): Cap[] {
    const tz = cfg.venue.timezone;
    const period = this.#periodAt(cfg, date, local);
    const caps: Cap[] = [];
    const pacing = period?.max_guests_per_interval ?? cfg.pacing?.max_guests_per_interval;
    if (pacing !== undefined) {
      const interval = cfg.pacing?.interval_minutes ?? 15;
      const bucket = Math.floor(time.minutesOfDay(local) / interval) * interval;
      const from = time.zonedToInstant(date, time.timeOfMinutes(bucket), tz).getTime();
      caps.push({
        from_ms: from,
        to_ms: from + interval * 60_000,
        max_guests: pacing,
        kind: 'pacing',
        label: local,
      });
    }
    if (period && period.max_online_guests !== undefined) {
      caps.push({
        from_ms: time.zonedToInstant(date, period.open, tz).getTime(),
        to_ms:
          period.close === '24:00'
            ? time.zonedToInstant(time.addDays(date, 1), '00:00', tz).getTime()
            : time.zonedToInstant(date, period.close, tz).getTime(),
        max_guests: period.max_online_guests,
        kind: 'online',
        label: period.name,
      });
    }
    return caps;
  }

  /** Refuse, with advice an agent can act on, when guests already fill a cap's window. */
  async #assertGuestRoom(
    cfg: VenueConfig,
    caps: Cap[],
    party: number,
    date: string,
    local: string,
    now: Date,
    ignoreBookingId?: string,
  ): Promise<void> {
    if (!caps.length) return;
    const booked = await this.#store.listBlocking(
      cfg.venue.id,
      Math.min(...caps.map((c) => c.from_ms)),
      Math.max(...caps.map((c) => c.to_ms)),
      now,
    );
    const hit = guestCapHit(
      caps,
      party,
      booked.filter((r) => r.booking.booking_id !== ignoreBookingId),
    );
    if (!hit) return;
    const phone = cfg.venue.phone_number ? ` at ${cfg.venue.phone_number}` : '';
    if (hit.kind === 'online') {
      throw new BookingError(
        'slot_unavailable',
        `Online bookings for ${hit.label} on ${date} are full for a party of ${party}.`,
        {
          suggested_next_action: `Tell the user the rest is kept for walk-ins. Offer another date or service, or suggest contacting the venue${phone}.`,
        },
      );
    }
    throw new BookingError(
      'slot_unavailable',
      `Too many guests are already booked to arrive around ${local} on ${date} for a party of ${party}.`,
      {
        suggested_next_action:
          'Search availability again for the same date and party size and offer the user a slightly earlier or later time.',
      },
    );
  }

  #offeringAllowed(
    cfg: VenueConfig,
    o: OfferingConfig,
    date: string,
    local: string,
    party: number,
  ): boolean {
    if (o.weekdays && !o.weekdays.includes(time.weekdayOfDate(date))) return false;
    if (o.first_start && local < o.first_start) return false;
    if (o.last_start && local > o.last_start) return false;
    // Must finish by closing time. This compares wall-clock minutes while the duration is elapsed
    // time, so it is off by the clock change on a venue open through the 02:00 change (OPE-98).
    const periods = cfg.opening_hours[time.weekdayOfDate(date)] ?? [];
    const startMin = time.minutesOfDay(local);
    return periods.some((p) => {
      const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
      return startMin >= time.minutesOfDay(p.open) && startMin + durationFor(o, party) <= close;
    });
  }

  /**
   * What can take this party, best first: single resources, smallest first (best fit keeps big
   * tables for big groups), then joined tables, fewest wasted seats first. Joined tables only
   * come after every single table, so a combination is offered only when no single one is free.
   */
  #placements(cfg: VenueConfig, o: OfferingConfig, party: number, tags: string[]): Placement[] {
    const singles = this.#fittingResources(cfg, o, party, tags).map((r): Placement => ({
      resources: [r],
      extraBufferMs: 0,
    }));
    const usable = (r: Resource) =>
      o.resource_kinds.includes(r.kind) &&
      (!o.resource_ids || o.resource_ids.includes(r.id)) &&
      tags.every((t) => matchesTag(r, t));
    const joined: Placement[] = [];
    for (const c of cfg.table_combinations ?? []) {
      if (party < c.min_party_size || party > c.max_party_size) continue;
      const members = c.resource_ids.map((id) => cfg.resources.find((r) => r.id === id)!);
      if (!members.every(usable)) continue;
      joined.push({
        resources: members,
        combination: c,
        extraBufferMs: (c.extra_buffer_minutes ?? 0) * 60_000,
      });
    }
    const seats = (p: Placement) => p.resources.reduce((n, r) => n + r.capacity.max, 0);
    const biggest = (p: Placement) => Math.max(...p.resources.map((r) => r.capacity.max));
    // Array.sort is stable, so equal choices keep the order they have in the config.
    joined.sort(
      (a, b) =>
        seats(a) - seats(b) || a.resources.length - b.resources.length || biggest(a) - biggest(b),
    );
    return [...singles, ...joined];
  }

  /** Resources that fit the party and tags, smallest first. */
  #fittingResources(
    cfg: VenueConfig,
    o: OfferingConfig,
    party: number,
    tags: string[],
  ): Resource[] {
    return cfg.resources
      .filter(
        (r) =>
          o.resource_kinds.includes(r.kind) &&
          (!o.resource_ids || o.resource_ids.includes(r.id)) &&
          r.capacity.min <= party &&
          party <= r.capacity.max &&
          tags.every((t) => matchesTag(r, t)),
      )
      .sort((a, b) => a.capacity.max - b.capacity.max);
  }

  #slot(
    cfg: VenueConfig,
    o: OfferingConfig,
    start: Date,
    party: number,
    placement: Placement,
    key: SlotKey,
    slotId = encodeSlotId(key),
  ): Slot {
    const tz = cfg.venue.timezone;
    const resource = placement.resources[0]!;
    const joined = placement.resources.length > 1;
    const end = new Date(start.getTime() + durationFor(o, party) * 60_000);
    return {
      slot_id: slotId,
      venue_id: cfg.venue.id,
      offering: { id: o.id, name: o.name },
      start: time.formatInZone(start, tz),
      end: time.formatInZone(end, tz),
      party_size: { total: party },
      resource: {
        id: resource.id,
        kind: resource.kind,
        label: joined
          ? joinedLabel(placement)
          : resource.capacity.max === 1 && resource.kind !== 'table'
            ? resource.name
            : `${capitalize(resource.kind)} for up to ${resource.capacity.max}`,
        // Only what every joined table has, so "outdoor" is never promised for a half-indoor pair.
        tags: joined
          ? resource.tags.filter((t) => placement.resources.every((r) => r.tags.includes(t)))
          : resource.tags,
      },
      ...(joined
        ? {
            additional_resources: placement.resources
              .slice(1)
              .map((r) => ({ id: r.id, kind: r.kind, label: r.name })),
          }
        : {}),
      price: o.price_per_person
        ? { amount: o.price_per_person.amount * party, currency: o.price_per_person.currency }
        : null,
      deposit: depositFor(o, party, cfg.currency),
      cancellation_policy: policyFor(o, start, party, cfg.currency, tz),
    };
  }
}

/** What a booking occupies: one resource, or several joined tables. */
interface Placement {
  /** The primary resource first. */
  resources: Resource[];
  combination?: TableCombination;
  /** Extra turnover after the booking, on top of the venue's buffer. */
  extraBufferMs: number;
}

const recordResources = (p: Placement) => ({
  resource_id: p.resources[0]!.id,
  ...(p.resources.length > 1 ? { extra_resource_ids: p.resources.slice(1).map((r) => r.id) } : {}),
});

/** "Tables T6 and T7 together", from the tables' names unless the config says otherwise. */
function joinedLabel(p: Placement): string {
  if (p.combination?.label) return p.combination.label;
  const kind = p.resources[0]!.kind;
  const prefix = new RegExp(`^${kind}s?\\s+`, 'i');
  const names = p.resources.map((r) => r.name.replace(prefix, ''));
  const list =
    names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ');
  return `${capitalize(kind)}s ${list} together`;
}

/** Every resource of the placement works the whole time and is free until it is turned over. */
function placementFree(
  cfg: VenueConfig,
  p: Placement,
  blocking: BusyInterval[],
  start: Date,
  date: string,
  local: string,
  duration: number,
  offering: OfferingConfig,
  party: number,
): boolean {
  const end = endOf(cfg, offering, start, party) + p.extraBufferMs;
  return p.resources.every(
    (r) => worksAt(cfg, r.id, date, local, duration) && isFree(blocking, r.id, start, end),
  );
}

/** When the table is free again: the party's table time plus turnover. */
function endOf(cfg: VenueConfig, o: OfferingConfig, start: Date, party: number): number {
  return start.getTime() + (durationFor(o, party) + cfg.buffer_minutes) * 60_000;
}

/** A guest limit with what an agent needs to hear when it is hit. */
interface Cap extends GuestCap {
  kind: 'pacing' | 'online';
  label: string;
}

const toStoreCap = ({ from_ms, to_ms, max_guests }: Cap): GuestCap => ({
  from_ms,
  to_ms,
  max_guests,
});

function hasCaps(cfg: VenueConfig): boolean {
  return (
    !!cfg.pacing ||
    !!cfg.service_periods?.some(
      (p) => p.max_guests_per_interval !== undefined || p.max_online_guests !== undefined,
    )
  );
}

/** The first cap that `party` more guests would break, given the blocking bookings read. */
function guestCapHit(
  caps: Cap[],
  party: number,
  booked: Array<{ start_ms: number; booking: { slot: { party_size: { total: number } } } }>,
): Cap | undefined {
  return caps.find((cap) => {
    let guests = party;
    for (const r of booked) {
      if (r.start_ms >= cap.from_ms && r.start_ms < cap.to_ms) {
        guests += r.booking.slot.party_size.total;
      }
    }
    return guests > cap.max_guests;
  });
}

/** Case-insensitive match on a tag, the resource name or its id: "Kari", "kari", "outdoor". */
function matchesTag(r: Resource, tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return (
    r.tags.some((x) => x.toLowerCase() === t) ||
    r.name.toLowerCase() === t ||
    r.id.toLowerCase() === t
  );
}

/** One bookable person (or room) rather than a table that seats a group. */
function isPerson(r: Resource): boolean {
  return r.capacity.max === 1 && r.kind !== 'table';
}

/** Whether the resource works the whole of [local, local + minutes) on `date` (venue-local). */
function worksAt(
  cfg: VenueConfig,
  resourceId: string,
  date: string,
  local: string,
  minutes: number,
): boolean {
  const hours = cfg.schedules?.[resourceId]?.hours;
  if (!hours) return true;
  const startMin = time.minutesOfDay(local);
  return (hours[time.weekdayOfDate(date)] ?? []).some((p) => {
    const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
    return startMin >= time.minutesOfDay(p.open) && startMin + minutes <= close;
  });
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A time-off bound as an instant: whole dates start at 00:00, and an end date is included. */
function timeOffBound(value: string, timeZone: string, end: boolean): number {
  if (LOCAL_DATE.test(value)) {
    return time.zonedToInstant(end ? time.addDays(value, 1) : value, '00:00', timeZone).getTime();
  }
  if (LOCAL_DATETIME.test(value)) {
    return time.zonedToInstant(value.slice(0, 10), value.slice(11), timeZone).getTime();
  }
  throw new Error(`Invalid time off "${value}": use YYYY-MM-DD or YYYY-MM-DDTHH:mm`);
}

/** Time off within [fromMs, toMs) as busy intervals, so it blocks exactly like a booking. */
function timeOff(cfg: VenueConfig, fromMs: number, toMs: number): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const [resource_id, schedule] of Object.entries(cfg.schedules ?? {})) {
    for (const off of schedule.time_off ?? []) {
      const start_ms = timeOffBound(off.start, cfg.venue.timezone, false);
      const end_ms = timeOffBound(off.end, cfg.venue.timezone, true);
      if (start_ms < toMs && fromMs < end_ms) out.push({ resource_id, start_ms, end_ms });
    }
  }
  return out;
}

/** Catch config mistakes in table times at startup. */
function validateOfferings(cfg: VenueConfig): void {
  for (const o of cfg.offerings) {
    for (const d of o.duration_by_party ?? []) {
      if (!Number.isInteger(d.min_party_size) || d.min_party_size < 1) {
        throw new Error(`Offering "${o.id}": duration_by_party needs min_party_size >= 1`);
      }
      if (!Number.isInteger(d.duration_minutes) || d.duration_minutes < 1) {
        throw new Error(`Offering "${o.id}": duration_by_party needs duration_minutes >= 1`);
      }
    }
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Catch config mistakes in pacing and service periods at startup. */
function validateService(cfg: VenueConfig): void {
  const ok = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 1);
  const id = cfg.venue.id;
  if (cfg.pacing && !ok(cfg.pacing.max_guests_per_interval)) {
    throw new Error(`${id}: pacing.max_guests_per_interval must be a whole number >= 1`);
  }
  if (cfg.pacing && !ok(cfg.pacing.interval_minutes)) {
    throw new Error(`${id}: pacing.interval_minutes must be a whole number >= 1`);
  }
  for (const p of cfg.service_periods ?? []) {
    const times = [p.open, ...(p.seatings ?? []), ...(p.close === '24:00' ? [] : [p.close])];
    if (times.some((t) => !HHMM.test(t))) {
      throw new Error(`${id}: service period "${p.name}" needs HH:mm times`);
    }
    if (!ok(p.max_guests_per_interval) || !ok(p.max_online_guests)) {
      throw new Error(`${id}: service period "${p.name}" limits must be whole numbers >= 1`);
    }
  }
}

/** Catch mistakes in joined tables at startup, where they are easy to fix. */
function validateCombinations(cfg: VenueConfig): void {
  const id = cfg.venue.id;
  const seen: Array<{ key: string; c: TableCombination }> = [];
  for (const c of cfg.table_combinations ?? []) {
    const name = `${id}: table combination ${c.resource_ids.join('+')}`;
    if (new Set(c.resource_ids).size !== c.resource_ids.length || c.resource_ids.length < 2) {
      throw new Error(`${name} needs two or more different tables`);
    }
    const members = c.resource_ids.map((rid) => {
      const r = cfg.resources.find((x) => x.id === rid);
      if (!r) throw new Error(`${name} names unknown resource "${rid}"`);
      return r;
    });
    if (new Set(members.map((r) => r.kind)).size > 1) {
      throw new Error(`${name} mixes kinds of resource`);
    }
    if (!cfg.offerings.some((o) => o.resource_kinds.includes(members[0]!.kind))) {
      throw new Error(`${name}: no offering uses resources of kind "${members[0]!.kind}"`);
    }
    if (!Number.isInteger(c.min_party_size) || c.min_party_size < 1) {
      throw new Error(`${name} needs min_party_size >= 1`);
    }
    if (!Number.isInteger(c.max_party_size) || c.max_party_size < c.min_party_size) {
      throw new Error(`${name} needs max_party_size >= min_party_size`);
    }
    if (c.max_party_size > members.reduce((n, r) => n + r.capacity.max, 0)) {
      throw new Error(`${name} seats up to ${c.max_party_size} but the tables hold fewer`);
    }
    const extra = c.extra_buffer_minutes;
    if (extra !== undefined && (!Number.isInteger(extra) || extra < 0)) {
      throw new Error(`${name} needs extra_buffer_minutes >= 0`);
    }
    // The same tables twice with party sizes that overlap would leave the choice ambiguous.
    const key = [...c.resource_ids].sort().join('+');
    const clash = seen.find(
      (o) =>
        o.key === key &&
        o.c.min_party_size <= c.max_party_size &&
        c.min_party_size <= o.c.max_party_size,
    );
    if (clash) throw new Error(`${name} is listed twice with overlapping party sizes`);
    seen.push({ key, c });
  }
}

/** Catch config mistakes at startup rather than as odd availability later. */
function validateSchedules(cfg: VenueConfig): void {
  for (const [id, schedule] of Object.entries(cfg.schedules ?? {})) {
    if (!cfg.resources.some((r) => r.id === id)) {
      throw new Error(`Schedule for unknown resource "${id}" at ${cfg.venue.id}`);
    }
    for (const off of schedule.time_off ?? []) {
      const start = timeOffBound(off.start, cfg.venue.timezone, false);
      if (timeOffBound(off.end, cfg.venue.timezone, true) <= start) {
        throw new Error(`Time off for "${id}" ends before it starts: ${off.start} → ${off.end}`);
      }
    }
  }
}

function isFree(blocking: BusyInterval[], resourceId: string, start: Date, endMs: number): boolean {
  const startMs = start.getTime();
  return !blocking.some(
    (r) => r.resource_id === resourceId && r.start_ms < endMs && startMs < r.end_ms,
  );
}

function depositFor(o: OfferingConfig, party: number, currency: string): DepositTerms | null {
  const rule = o.deposit;
  if (!rule || party < rule.min_party_size) return null;
  const amount: Money = { amount: rule.amount_per_person * party, currency };
  return {
    amount,
    due: rule.due,
    description:
      `Deposit of ${fmt(amount)} (${fmt({ amount: rule.amount_per_person, currency })} per guest) ` +
      (rule.due === 'at_confirmation' ? 'charged at confirmation' : 'payable at the venue') +
      '; deducted from the bill. Refunds follow the cancellation policy.',
  };
}

function policyFor(
  o: OfferingConfig,
  start: Date,
  party: number,
  currency: string,
  tz: string,
): CancellationPolicy {
  const r = o.cancellation;
  const freeUntil =
    r.free_until_hours_before === null
      ? null
      : new Date(start.getTime() - r.free_until_hours_before * 3_600_000);
  const late =
    r.late_fee_per_person === null ? null : { amount: r.late_fee_per_person * party, currency };
  const noShow =
    r.no_show_fee_per_person === null
      ? null
      : { amount: r.no_show_fee_per_person * party, currency };
  const parts = [
    freeUntil
      ? `Free cancellation until ${time.formatInZone(freeUntil, tz)} (${r.free_until_hours_before} hours before).`
      : 'Not refundable.',
    late ? `Later cancellations cost ${fmt(late)}.` : '',
    noShow ? `No-shows are charged ${fmt(noShow)}.` : '',
    'Bookings cannot be cancelled online after the start time.',
  ];
  return {
    refundability: r.refundability,
    description: parts.filter(Boolean).join(' '),
    free_cancellation_until: freeUntil ? time.formatInZone(freeUntil, tz) : null,
    late_cancellation_fee: late,
    no_show_fee: noShow,
  };
}

function paymentFor(deposit: DepositTerms | null): Booking['payment'] {
  if (!deposit) return { status: 'not_required', amount: null, reference: null };
  return {
    status: deposit.due === 'at_venue' ? 'due_at_venue' : 'pending',
    amount: deposit.amount,
    reference: null,
  };
}

export function encodeSlotId(key: SlotKey): string {
  return `slot_${Buffer.from(JSON.stringify(key)).toString('base64url')}`;
}

function decodeSlotId(slotId: string): SlotKey {
  try {
    if (!slotId.startsWith('slot_')) throw new Error();
    const k = JSON.parse(Buffer.from(slotId.slice(5), 'base64url').toString('utf8')) as SlotKey;
    if (
      typeof k.v !== 'string' ||
      typeof k.o !== 'string' ||
      typeof k.s !== 'string' ||
      typeof k.p !== 'number'
    ) {
      throw new Error();
    }
    return k;
  } catch {
    throw invalidSlot();
  }
}

/** Thrown inside a store move when the booking changed since it was read; the move is retried. */
const STALE = new Error('booking changed since it was read');

function invalidSlot(): BookingError {
  return new BookingError('validation_error', 'slot_id is not valid.', {
    suggested_next_action: 'Use a slot_id exactly as returned by search_availability.',
  });
}

const fmt = (m: Money) => `${(m.amount / 100).toFixed(0)} ${m.currency}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
