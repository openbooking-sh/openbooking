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
  type DepositTerms,
  type Money,
  type ProviderContext,
  type Offering,
  type Resource,
  type Slot,
  type UpdateBookingRequest,
  type Venue,
} from '@openbooking/core';
import type { MemoryProviderConfig, OfferingConfig, VenueConfig } from './config';
import {
  MemoryBookingStore,
  isBlocking,
  type BookingRecord,
  type BookingRecordStore,
} from './store';

export interface MemoryProviderOptions {
  /** Where bookings live. Defaults to an in-process Map; use a Postgres store in production. */
  store?: BookingRecordStore;
}

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
 * `@openbooking/postgres`. Atomic check-and-reserve is the store's job (`insertIfFree`), so two
 * overlapping holds can never both succeed with either store.
 */
export class MemoryBookingProvider implements BookingProvider {
  readonly info: { name: string; description?: string };
  readonly #venues: Map<string, VenueConfig>;
  readonly #store: BookingRecordStore;

  constructor(config: MemoryProviderConfig, options: MemoryProviderOptions = {}) {
    this.#store = options.store ?? new MemoryBookingStore();
    this.info = {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
    };
    this.#venues = new Map(config.venues.map((v) => [v.venue.id, v]));
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
    const maxCapacity = Math.max(...cfg.resources.map((r) => r.capacity.max));
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
    const starts = this.#candidateStarts(cfg, query.date, ctx.now);
    if (!starts.length) return slots;
    // One read for the whole day; the per-slot checks below run against this snapshot.
    const longest = Math.max(...offerings.map((o) => o.duration_minutes), 0) + cfg.buffer_minutes;
    const blocking = await this.#store.listBlocking(
      cfg.venue.id,
      starts[0]!.getTime(),
      starts[starts.length - 1]!.getTime() + longest * 60_000,
      ctx.now,
    );
    for (const start of starts) {
      const local = time.localTime(start, cfg.venue.timezone);
      if (query.time_from && local < query.time_from) continue;
      if (query.time_to && local > query.time_to) continue;
      for (const offering of offerings) {
        if (!this.#offeringAllowed(cfg, offering, query.date, local)) continue;
        const resource = this.#fittingResources(cfg, offering, party, query.tags ?? []).find((r) =>
          isFree(blocking, r.id, start, endOf(cfg, offering, start)),
        );
        if (!resource) continue;
        slots.push(
          this.#slot(cfg, offering, start, party, resource, {
            v: cfg.venue.id,
            o: offering.id,
            s: start.toISOString(),
            p: party,
            ...(query.tags?.length ? { t: query.tags } : {}),
          }),
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
      this.#offeringAllowed(cfg, offering, date, local);
    if (!bookable) {
      throw new BookingError(
        'slot_unavailable',
        'This slot is no longer bookable (in the past or outside opening hours).',
      );
    }

    const now = ctx.now.toISOString();
    const bookingId = `bk_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    // Best fit first; the store's atomic insert decides, so a lost race moves on to the next one.
    for (const resource of this.#fittingResources(cfg, offering, key.p, key.t ?? [])) {
      const slot = this.#slot(cfg, offering, start, key.p, resource, key, req.slot_id);
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
        resource_id: resource.id,
        start_ms: start.getTime(),
        end_ms: endOf(cfg, offering, start),
      };
      if (await this.#store.insertIfFree(record, ctx.now)) return booking;
    }
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
        if (token.startsWith('manual:')) {
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

  async cancelBooking(req: CancelBookingRequest, ctx: ProviderContext): Promise<Booking> {
    const at = ctx.now.toISOString();
    return this.#update(req.booking_id, ctx, (b) => ({
      ...b,
      status: 'cancelled',
      expires_at: null,
      cancelled_at: at,
      updated_at: at,
      cancellation: { reason: req.reason, fee: req.fee, refund: req.refund },
    }));
  }

  // ---------------------------------------------------------------------------
  // Introspection (tests, benchmark)
  // ---------------------------------------------------------------------------

  async listBookings(
    query: { from?: Date; to?: Date; limit?: number },
    ctx: ProviderContext,
  ): Promise<Booking[]> {
    return (await this.#store.list(query, ctx.now)).map((r) => r.booking);
  }

  /** All bookings with their internal resource assignment (tests, benchmark). */
  async inspectBookings(now: Date): Promise<Array<Booking & { resource_id: string }>> {
    return (await this.#store.list({ limit: 1_000_000 }, now)).map((r) => ({
      ...r.booking,
      resource_id: r.resource_id,
    }));
  }

  /** Pairs of active bookings that overlap on the same resource. Should always be empty. */
  async findOverlaps(now: Date): Promise<Array<[string, string]>> {
    const active = (await this.#store.list({ limit: 1_000_000 }, now)).filter((r) =>
      isBlocking(r.booking, now),
    );
    const out: Array<[string, string]> = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!;
        const b = active[j]!;
        if (a.resource_id === b.resource_id && a.start_ms < b.end_ms && b.start_ms < a.end_ms) {
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
    const periods = cfg.opening_hours[time.weekdayOfDate(date)] ?? [];
    const earliest = now.getTime() + cfg.min_lead_minutes * 60_000;
    const out: Date[] = [];
    for (const p of periods) {
      const open = time.minutesOfDay(p.open);
      const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
      for (let m = open; m < close; m += cfg.slot_interval_minutes) {
        const start = time.zonedToInstant(date, time.timeOfMinutes(m), cfg.venue.timezone);
        if (start.getTime() >= earliest) out.push(start);
      }
    }
    return out;
  }

  #offeringAllowed(cfg: VenueConfig, o: OfferingConfig, date: string, local: string): boolean {
    if (o.weekdays && !o.weekdays.includes(time.weekdayOfDate(date))) return false;
    if (o.first_start && local < o.first_start) return false;
    if (o.last_start && local > o.last_start) return false;
    // Must finish by closing time.
    const periods = cfg.opening_hours[time.weekdayOfDate(date)] ?? [];
    const startMin = time.minutesOfDay(local);
    return periods.some((p) => {
      const close = p.close === '24:00' ? 1440 : time.minutesOfDay(p.close);
      return startMin >= time.minutesOfDay(p.open) && startMin + o.duration_minutes <= close;
    });
  }

  /** Resources that fit the party and tags, smallest first (best fit keeps big tables for big groups). */
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
          r.capacity.min <= party &&
          party <= r.capacity.max &&
          tags.every((t) => r.tags.includes(t)),
      )
      .sort((a, b) => a.capacity.max - b.capacity.max);
  }

  #slot(
    cfg: VenueConfig,
    o: OfferingConfig,
    start: Date,
    party: number,
    resource: Resource,
    key: SlotKey,
    slotId = encodeSlotId(key),
  ): Slot {
    const tz = cfg.venue.timezone;
    const end = new Date(start.getTime() + o.duration_minutes * 60_000);
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
        label:
          resource.capacity.max === 1 && resource.kind !== 'table'
            ? resource.name
            : `${capitalize(resource.kind)} for up to ${resource.capacity.max}`,
        tags: resource.tags,
      },
      price: o.price_per_person
        ? { amount: o.price_per_person.amount * party, currency: o.price_per_person.currency }
        : null,
      deposit: depositFor(o, party, cfg.currency),
      cancellation_policy: policyFor(o, start, party, cfg.currency, tz),
    };
  }
}

function endOf(cfg: VenueConfig, o: OfferingConfig, start: Date): number {
  return start.getTime() + (o.duration_minutes + cfg.buffer_minutes) * 60_000;
}

function isFree(
  blocking: BookingRecord[],
  resourceId: string,
  start: Date,
  endMs: number,
): boolean {
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

function invalidSlot(): BookingError {
  return new BookingError('validation_error', 'slot_id is not valid.', {
    suggested_next_action: 'Use a slot_id exactly as returned by search_availability.',
  });
}

const fmt = (m: Money) => `${(m.amount / 100).toFixed(0)} ${m.currency}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
