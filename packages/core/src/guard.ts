/**
 * Anti-scalping: limits per guest and per agent, name-bound bookings, and broker-pattern flags.
 *
 * Real assistants act for one consenting person; scalper bots book in bulk. Everything here is
 * optional (`BookingServiceOptions.guard`); without it the engine behaves exactly as before.
 *
 * How it stays atomic. The booking system (provider) owns inventory; this module owns a small
 * ledger of who holds what, keyed by booking id. A limit is checked and the ledger entry written
 * in ONE atomic store call (`GuardStore.claim`), so two concurrent holds for the same guest can't
 * both slip under the limit. The hold itself is created first (core cannot read a slot id), and is
 * released again if the ledger refuses it.
 *
 * What the ledger keeps. Never a name, email or phone number: contact details and names are
 * reduced to salted HMAC lookup keys, so the ledger can answer "how many bookings does this
 * contact have" without being a second copy of the customer list.
 *
 * Verified agent identity (Web Bot Auth, OPE-57) is NOT here. The extension point is
 * `GuardOptions.identifyAgent`: return a verified agent id from the request's actor and the agent
 * limits and flags key on it instead of the self-reported client name.
 */
import { createHmac } from 'node:crypto';
import type { Actor } from './actor';
import type { Booking, Customer } from './schemas';

/** A stable, hashed identity: `e` (email), `p` (phone). Never reversible without the salt. */
export type GuestKey = string;

export interface GuardLimits {
  /** Active bookings of one guest at one venue. */
  guest_venue?: number;
  /** Active bookings of one guest at one venue on one day (venue-local date of the start). */
  guest_day?: number;
  /** Holds one agent has open at once at one venue. */
  agent_holds?: number;
  /** Active (held or confirmed) bookings of one agent at one venue. */
  agent_active?: number;
}

export interface GuardEntry {
  booking_id: string;
  venue_id: string;
  /** YYYY-MM-DD, taken from the slot's own offset (the venue's local date). */
  day: string;
  start_ms: number;
  end_ms: number;
  status: 'held' | 'confirmed' | 'cancelled';
  /** While held: when the hold lapses. null once confirmed or cancelled. */
  hold_expires_ms: number | null;
  guest_keys: GuestKey[];
  /** Hashed normalised customer name; null while nobody is named. */
  name_key: string | null;
  /** Who made it: a protocol-level client id, or a verified id from `identifyAgent`. */
  agent_key: string | null;
  created_ms: number;
  cancelled_ms: number | null;
  /** What it was when cancelled, so releasing an unconfirmed hold is not counted as churn. */
  cancelled_from: 'held' | 'confirmed' | null;
  /** Broker-pattern flags (staff only), see {@link FlagRules}. */
  flags: string[];
}

export type GuardClaim = { ok: true } | { ok: false; limit: keyof GuardLimits };

/**
 * Where the ledger lives. `claim` MUST be atomic: count the live entries against `limits` and write
 * `entry` as one step, across every instance sharing the store (memory: one process; Postgres:
 * `PostgresGuardStore`, a per-venue advisory lock).
 */
export interface GuardStore {
  /**
   * Insert or update the entry for `entry.booking_id` unless it would break a limit. An update
   * keeps the original `created_ms`, the flags and any agent or name already recorded, and does not
   * erase guest keys with an empty list. The entry itself never counts against its own limit.
   */
  claim(entry: GuardEntry, limits: GuardLimits, now: Date): Promise<GuardClaim>;
  /** Mark cancelled (a released hold or a cancelled booking). No-op when unknown. */
  release(bookingId: string, now: Date): Promise<void>;
  get(bookingId: string): Promise<GuardEntry | undefined>;
  /** Entries of a venue created or cancelled since `sinceMs` by this agent or any of these keys. */
  recent(
    query: { venue_id: string; agent_key?: string | null; guest_keys?: GuestKey[] },
    sinceMs: number,
  ): Promise<GuardEntry[]>;
  addFlags(bookingId: string, flags: string[]): Promise<void>;
  flagsOf(bookingIds: string[]): Promise<Map<string, string[]>>;
  /** Forget entries of bookings that ended before `beforeMs`, so hashes don't pile up. Optional. */
  purge?(beforeMs: number): Promise<number>;
}

/** A broker-pattern rule: `count` or more distinct names/cancellations within `window_hours`. */
export interface FlagRule {
  count: number;
  window_hours: number;
}

/**
 * The signals that add up to a flag. A flag marks the booking for the venue's staff; it never
 * refuses a booking and never bans anyone. Set a rule to `false` to turn it off.
 *
 * Note: an agent key is the assistant's self-reported client name, shared by all its users, so
 * the agent rules default to counts only an abusive volume would reach. A verified per-agent id
 * (`identifyAgent`) lets you tighten them.
 */
export interface FlagRules {
  /** One agent booking under many different names. Default 10 names in 24 hours. */
  agent_many_names?: FlagRule | false;
  /** One email or phone number booking under many different names. Default 3 names in 30 days. */
  contact_many_names?: FlagRule | false;
  /** One agent booking then cancelling again and again. Default 10 in 24 hours. */
  agent_cancel_churn?: FlagRule | false;
  /** One contact booking then cancelling again and again. Default 3 in 7 days. */
  contact_cancel_churn?: FlagRule | false;
}

export const DEFAULT_FLAG_RULES: Required<{ [K in keyof FlagRules]: FlagRule }> = {
  agent_many_names: { count: 10, window_hours: 24 },
  contact_many_names: { count: 3, window_hours: 30 * 24 },
  agent_cancel_churn: { count: 10, window_hours: 24 },
  contact_cancel_churn: { count: 3, window_hours: 7 * 24 },
};

export interface GuardOptions {
  /**
   * Secret that turns contact details and names into lookup keys. Set your own and keep it stable:
   * changing it makes existing ledger entries unfindable. The default is public, so keys are
   * only as private as the database.
   */
  salt?: string;
  /** Limits per customer identity (normalised email or phone number). */
  guest?: {
    /** Max upcoming (held or confirmed, not yet ended) bookings per guest at a venue. */
    maxActive?: number;
    /** Max of them on one day. */
    maxPerDay?: number;
  };
  /** Limits per agent identity. Without `identifyAgent` that is the MCP/UCP/A2A client name. */
  agent?: {
    /** Max holds one agent has open at once at a venue. */
    maxHolds?: number;
    /** Max upcoming (held or confirmed) bookings one agent has at a venue. */
    maxActive?: number;
  };
  /**
   * A booking is for the person it names: once it names someone, only the venue (Studio) can name
   * somebody else. The terms shown before booking say so.
   */
  nonTransferable?: boolean;
  /** Broker-pattern flags. On by default whenever `guard` is set; `false` turns them all off. */
  flags?: FlagRules | false;
  /**
   * Who is calling, as far as the venue can tell. Return a verified agent id here when you have
   * one (Web Bot Auth, OPE-57), or an API key id. Return undefined to apply no agent limits to the
   * call. The default is `protocol:client` for MCP, UCP, USP and A2A calls that name a client,
   * which is self-reported and shared by every user of that assistant, so keep agent limits high.
   */
  identifyAgent?: (actor: Actor) => string | undefined;
  /** Default: in memory. Pass a shared store (`PostgresGuardStore`) when several instances run. */
  store?: GuardStore;
}

export const NON_TRANSFERABLE_NOTICE =
  'This booking is in the guest’s name and cannot be transferred to anyone else.';

// ---------------------------------------------------------------------------
// Pure rules (shared by every store, so memory and Postgres agree)
// ---------------------------------------------------------------------------

/** Counts against limits: a live hold or a confirmed booking that has not ended yet. */
export function isActive(e: GuardEntry, now: Date): boolean {
  const t = now.getTime();
  if (e.end_ms <= t) return false;
  if (e.status === 'confirmed') return true;
  return e.status === 'held' && e.hold_expires_ms !== null && e.hold_expires_ms > t;
}

const shares = (a: readonly string[], b: readonly string[]) => a.some((k) => b.includes(k));

/** Which limit `entry` would break, given every other entry of the venue that might matter. */
export function limitHit(
  others: readonly GuardEntry[],
  entry: GuardEntry,
  limits: GuardLimits,
  now: Date,
): keyof GuardLimits | undefined {
  const live = others.filter(
    (o) => o.booking_id !== entry.booking_id && o.venue_id === entry.venue_id && isActive(o, now),
  );
  // The new entry counts as one itself, but only if it would be active.
  const guestLive = entry.guest_keys.length
    ? live.filter((o) => shares(o.guest_keys, entry.guest_keys))
    : [];
  if (limits.guest_venue !== undefined && entry.guest_keys.length) {
    if (guestLive.length + 1 > limits.guest_venue) return 'guest_venue';
  }
  if (limits.guest_day !== undefined && entry.guest_keys.length) {
    if (guestLive.filter((o) => o.day === entry.day).length + 1 > limits.guest_day) {
      return 'guest_day';
    }
  }
  if (entry.agent_key) {
    const agentLive = live.filter((o) => o.agent_key === entry.agent_key);
    if (limits.agent_holds !== undefined && entry.status === 'held') {
      if (agentLive.filter((o) => o.status === 'held').length + 1 > limits.agent_holds) {
        return 'agent_holds';
      }
    }
    if (limits.agent_active !== undefined && agentLive.length + 1 > limits.agent_active) {
      return 'agent_active';
    }
  }
  return undefined;
}

/** Merge a claim into what the ledger already knows about that booking. */
export function mergeEntry(existing: GuardEntry | undefined, incoming: GuardEntry): GuardEntry {
  if (!existing) return { ...incoming };
  return {
    ...incoming,
    created_ms: existing.created_ms,
    flags: existing.flags,
    agent_key: existing.agent_key ?? incoming.agent_key,
    name_key: incoming.name_key ?? existing.name_key,
    guest_keys: incoming.guest_keys.length ? incoming.guest_keys : existing.guest_keys,
    cancelled_ms: null,
    cancelled_from: null,
  };
}

/** Flags that this booking's history triggers. Pure: give it the entries `recent` returned. */
export function evaluateFlags(
  entry: GuardEntry,
  byAgent: readonly GuardEntry[],
  byGuest: readonly GuardEntry[],
  rules: FlagRules,
  now: Date,
): string[] {
  const merged: FlagRules = { ...DEFAULT_FLAG_RULES, ...rules };
  const out: string[] = [];
  const since = (r: FlagRule) => now.getTime() - r.window_hours * 3_600_000;
  const names = (list: readonly GuardEntry[], from: number) =>
    new Set(list.filter((e) => e.created_ms >= from && e.name_key).map((e) => e.name_key));
  const churn = (list: readonly GuardEntry[], from: number) =>
    list.filter(
      (e) => e.cancelled_from === 'confirmed' && e.cancelled_ms !== null && e.cancelled_ms >= from,
    ).length;

  const a = merged.agent_many_names;
  if (a && entry.agent_key && names(byAgent, since(a)).size >= a.count) {
    out.push('agent_many_names');
  }
  const c = merged.contact_many_names;
  if (c && entry.guest_keys.length && names(byGuest, since(c)).size >= c.count) {
    out.push('contact_many_names');
  }
  const ac = merged.agent_cancel_churn;
  if (ac && entry.agent_key && churn(byAgent, since(ac)) >= ac.count) {
    out.push('agent_cancel_churn');
  }
  const cc = merged.contact_cancel_churn;
  if (cc && entry.guest_keys.length && churn(byGuest, since(cc)) >= cc.count) {
    out.push('contact_cancel_churn');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Memory store
// ---------------------------------------------------------------------------

/** The ledger in a Map. Each method runs without awaiting, so a claim is atomic on one thread. */
export class MemoryGuardStore implements GuardStore {
  readonly #entries = new Map<string, GuardEntry>();

  async claim(entry: GuardEntry, limits: GuardLimits, now: Date): Promise<GuardClaim> {
    const hit = limitHit([...this.#entries.values()], entry, limits, now);
    if (hit) return { ok: false, limit: hit };
    this.#entries.set(
      entry.booking_id,
      structuredClone(mergeEntry(this.#entries.get(entry.booking_id), entry)),
    );
    return { ok: true };
  }

  async release(bookingId: string, now: Date): Promise<void> {
    const e = this.#entries.get(bookingId);
    if (!e || e.status === 'cancelled') return;
    e.cancelled_from = e.status;
    e.status = 'cancelled';
    e.hold_expires_ms = null;
    e.cancelled_ms = now.getTime();
  }

  async get(bookingId: string) {
    const e = this.#entries.get(bookingId);
    return e ? structuredClone(e) : undefined;
  }

  async recent(
    query: { venue_id: string; agent_key?: string | null; guest_keys?: GuestKey[] },
    sinceMs: number,
  ) {
    return [...this.#entries.values()]
      .filter(
        (e) =>
          e.venue_id === query.venue_id &&
          (e.created_ms >= sinceMs || (e.cancelled_ms ?? 0) >= sinceMs) &&
          ((!!query.agent_key && e.agent_key === query.agent_key) ||
            shares(e.guest_keys, query.guest_keys ?? [])),
      )
      .map((e) => structuredClone(e));
  }

  async addFlags(bookingId: string, flags: string[]) {
    const e = this.#entries.get(bookingId);
    if (e) e.flags = [...new Set([...e.flags, ...flags])];
  }

  async flagsOf(bookingIds: string[]) {
    const out = new Map<string, string[]>();
    for (const id of bookingIds) {
      const f = this.#entries.get(id)?.flags;
      if (f?.length) out.set(id, [...f]);
    }
    return out;
  }

  async purge(beforeMs: number) {
    let n = 0;
    for (const [id, e] of [...this.#entries]) {
      if (e.end_ms < beforeMs && this.#entries.delete(id)) n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Lower-case, and for the providers known to ignore them, drop dots and `+tags`, so
 * `A.Lovelace+x@gmail.com` and `alovelace@gmail.com` are one guest.
 */
export function normalizeEmail(email: string): string {
  const [rawLocal = '', rawDomain = ''] = email.trim().toLowerCase().split('@');
  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain;
  let local = rawLocal.split('+')[0] || rawLocal;
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

/** Digits only, so spacing and punctuation don't make a second guest. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function normalizeName(c: Pick<Customer, 'first_name' | 'last_name'>): string {
  return `${c.first_name} ${c.last_name}`.trim().toLowerCase().replace(/\s+/g, ' ');
}

const DEFAULT_SALT = 'openbooking-guard-v1';
/** A phone number needs this many digits before it identifies anyone. */
const MIN_PHONE_DIGITS = 6;

/** The engine's view of {@link GuardOptions}: keys, limits, notices, flags. */
export class Guard {
  readonly store: GuardStore;
  readonly nonTransferable: boolean;
  readonly #salt: string;
  readonly #options: GuardOptions;

  constructor(options: GuardOptions) {
    this.#options = options;
    this.store = options.store ?? new MemoryGuardStore();
    this.nonTransferable = options.nonTransferable === true;
    this.#salt = options.salt ?? DEFAULT_SALT;
  }

  #hash(kind: string, value: string): string {
    return `${kind}:${createHmac('sha256', this.#salt).update(`${kind}:${value}`).digest('hex').slice(0, 32)}`;
  }

  guestKeys(customer: Customer | null | undefined): GuestKey[] {
    if (!customer) return [];
    const keys: GuestKey[] = [];
    if (customer.email) keys.push(this.#hash('e', normalizeEmail(customer.email)));
    const phone = customer.phone_number ? normalizePhone(customer.phone_number) : '';
    if (phone.length >= MIN_PHONE_DIGITS) keys.push(this.#hash('p', phone));
    return keys;
  }

  nameKey(customer: Pick<Customer, 'first_name' | 'last_name'> | null | undefined): string | null {
    return customer ? this.#hash('n', normalizeName(customer)) : null;
  }

  /** The calling agent, if it can be told from anyone else; undefined for staff and humans. */
  agentKey(actor: Actor | undefined): string | undefined {
    if (!actor || actor.protocol === 'studio') return undefined;
    const custom = this.#options.identifyAgent;
    const raw = custom
      ? custom(actor)
      : ['mcp', 'ucp', 'usp', 'a2a'].includes(actor.protocol) && actor.client
        ? `${actor.protocol}:${actor.client}`
        : undefined;
    return raw ? raw.trim().toLowerCase().slice(0, 200) || undefined : undefined;
  }

  /** The limits to enforce for this call (none for the venue's own staff). */
  limits(actor: Actor | undefined, kind: 'hold' | 'confirm'): GuardLimits {
    if (actor?.protocol === 'studio') return {};
    const g = this.#options.guest ?? {};
    const a = this.#options.agent ?? {};
    return {
      ...(g.maxActive !== undefined ? { guest_venue: g.maxActive } : {}),
      ...(g.maxPerDay !== undefined ? { guest_day: g.maxPerDay } : {}),
      ...(kind === 'hold' && a.maxHolds !== undefined ? { agent_holds: a.maxHolds } : {}),
      ...(kind === 'hold' && a.maxActive !== undefined ? { agent_active: a.maxActive } : {}),
    };
  }

  entryFor(
    booking: Booking,
    extra: {
      customer: Customer | null | undefined;
      agentKey: string | undefined;
      status: GuardEntry['status'];
      now: Date;
    },
  ): GuardEntry {
    const hold = booking.expires_at ? Date.parse(booking.expires_at) : null;
    return {
      booking_id: booking.booking_id,
      venue_id: booking.venue_id,
      day: booking.slot.start.slice(0, 10),
      start_ms: Date.parse(booking.slot.start),
      end_ms: Date.parse(booking.slot.end),
      status: extra.status,
      hold_expires_ms: extra.status === 'held' ? hold : null,
      guest_keys: this.guestKeys(extra.customer),
      name_key: this.nameKey(extra.customer),
      agent_key: extra.agentKey ?? null,
      created_ms: extra.now.getTime(),
      cancelled_ms: null,
      cancelled_from: null,
      flags: [],
    };
  }

  /** Raise flags for what this booking's contact and agent have been doing. Never throws. */
  async flag(bookingId: string, now: Date): Promise<void> {
    const rules = this.#options.flags;
    if (rules === false) return;
    try {
      const entry = await this.store.get(bookingId);
      if (!entry) return;
      const merged = { ...DEFAULT_FLAG_RULES, ...rules };
      const widest = Math.max(
        ...Object.values(merged)
          .filter((r): r is FlagRule => !!r)
          .map((r) => r.window_hours),
      );
      const recent = await this.store.recent(
        { venue_id: entry.venue_id, agent_key: entry.agent_key, guest_keys: entry.guest_keys },
        now.getTime() - widest * 3_600_000,
      );
      const byAgent = recent.filter((e) => !!entry.agent_key && e.agent_key === entry.agent_key);
      const byGuest = recent.filter((e) => shares(e.guest_keys, entry.guest_keys));
      const flags = evaluateFlags(entry, byAgent, byGuest, rules ?? {}, now);
      if (flags.length) await this.store.addFlags(bookingId, flags);
    } catch {
      // Flagging is advice to the venue; it must never break a booking.
    }
  }
}
