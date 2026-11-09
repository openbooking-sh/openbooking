import {
  limitHit,
  mergeEntry,
  type GuardClaim,
  type GuardEntry,
  type GuardLimits,
  type GuardStore,
  type GuestKey,
} from '@openbooking-sh/core';
import { LOCK_SQL, type Db } from './db';

interface Row {
  booking_id: string;
  venue_id: string;
  day: string;
  start_at: Date;
  end_at: Date;
  status: GuardEntry['status'];
  hold_expires_at: Date | null;
  guest_keys: string[];
  name_key: string | null;
  agent_key: string | null;
  created_at: Date;
  cancelled_at: Date | null;
  cancelled_from: GuardEntry['cancelled_from'];
  flags: string[];
}

const COLUMNS = `booking_id, venue_id, day, start_at, end_at, status, hold_expires_at, guest_keys,
  name_key, agent_key, created_at, cancelled_at, cancelled_from, flags`;

/**
 * The anti-scalping ledger in Postgres, shared by every server instance. It holds hashed lookup
 * keys, never a name, email or phone number.
 *
 * A claim takes a transaction-scoped advisory lock for the venue, reads the entries that could
 * matter (same guest key or same agent, still upcoming), applies the same pure rule the memory
 * store uses, and writes the entry. Every claim of a venue holds that lock, so two concurrent
 * claims can never both pass a limit that only has room for one.
 */
export class PostgresGuardStore implements GuardStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async claim(entry: GuardEntry, limits: GuardLimits, now: Date): Promise<GuardClaim> {
    return this.#db.transaction(async (tx) => {
      await tx.query(LOCK_SQL, [lockKey(entry.venue_id)]);
      if (Object.keys(limits).length) {
        const { rows } = await tx.query<Row>(
          `select ${COLUMNS} from ob_guard
            where venue_id = $1 and booking_id <> $2 and status <> 'cancelled'
              and end_at > $3::timestamptz
              and (guest_keys && $4::text[] or (agent_key is not null and agent_key = $5))`,
          [entry.venue_id, entry.booking_id, now.toISOString(), entry.guest_keys, entry.agent_key],
        );
        const hit = limitHit(rows.map(toEntry), entry, limits, now);
        if (hit) return { ok: false as const, limit: hit };
      }
      const { rows: existing } = await tx.query<Row>(
        `select ${COLUMNS} from ob_guard where booking_id = $1`,
        [entry.booking_id],
      );
      const next = mergeEntry(existing[0] ? toEntry(existing[0]) : undefined, entry);
      await tx.query(
        `insert into ob_guard
           (booking_id, venue_id, day, start_at, end_at, status, hold_expires_at, guest_keys,
            name_key, agent_key, created_at, cancelled_at, cancelled_from, flags)
         values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::timestamptz, $8::text[],
                 $9, $10, $11::timestamptz, null, null, $12::text[])
         on conflict (booking_id) do update set
           day = excluded.day, start_at = excluded.start_at, end_at = excluded.end_at,
           status = excluded.status, hold_expires_at = excluded.hold_expires_at,
           guest_keys = excluded.guest_keys, name_key = excluded.name_key,
           agent_key = excluded.agent_key, cancelled_at = null, cancelled_from = null`,
        [
          next.booking_id,
          next.venue_id,
          next.day,
          iso(next.start_ms),
          iso(next.end_ms),
          next.status,
          next.hold_expires_ms === null ? null : iso(next.hold_expires_ms),
          next.guest_keys,
          next.name_key,
          next.agent_key,
          iso(next.created_ms),
          next.flags,
        ],
      );
      return { ok: true as const };
    });
  }

  async release(bookingId: string, now: Date): Promise<void> {
    await this.#db.query(
      `update ob_guard
          set cancelled_from = status, status = 'cancelled', hold_expires_at = null,
              cancelled_at = $2::timestamptz
        where booking_id = $1 and status <> 'cancelled'`,
      [bookingId, now.toISOString()],
    );
  }

  async get(bookingId: string) {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from ob_guard where booking_id = $1`,
      [bookingId],
    );
    return rows[0] ? toEntry(rows[0]) : undefined;
  }

  async recent(
    query: { venue_id: string; agent_key?: string | null; guest_keys?: GuestKey[] },
    sinceMs: number,
  ) {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from ob_guard
        where venue_id = $1
          and (created_at >= $2::timestamptz or cancelled_at >= $2::timestamptz)
          and (guest_keys && $3::text[] or (agent_key is not null and agent_key = $4))`,
      [query.venue_id, iso(sinceMs), query.guest_keys ?? [], query.agent_key ?? null],
    );
    return rows.map(toEntry);
  }

  async addFlags(bookingId: string, flags: string[]) {
    // One statement, so concurrent flaggers merge instead of overwriting each other.
    await this.#db.query(
      `update ob_guard
          set flags = array(select distinct f from unnest(flags || $2::text[]) as f order by f)
        where booking_id = $1`,
      [bookingId, flags],
    );
  }

  async flagsOf(bookingIds: string[]) {
    const out = new Map<string, string[]>();
    if (!bookingIds.length) return out;
    const { rows } = await this.#db.query<{ booking_id: string; flags: string[] }>(
      `select booking_id, flags from ob_guard
        where booking_id = any($1::text[]) and cardinality(flags) > 0`,
      [bookingIds],
    );
    for (const r of rows) out.set(r.booking_id, r.flags);
    return out;
  }

  async purge(beforeMs: number) {
    const { rows } = await this.#db.query(
      'delete from ob_guard where end_at < $1::timestamptz returning booking_id',
      [iso(beforeMs)],
    );
    return rows.length;
  }

  /** Delete every entry of a venue (a hosted business closing its account). Resolves how many. */
  async deleteVenue(venueId: string) {
    const { rows } = await this.#db.query(
      'delete from ob_guard where venue_id = $1 returning booking_id',
      [venueId],
    );
    return rows.length;
  }
}

function toEntry(r: Row): GuardEntry {
  return {
    booking_id: r.booking_id,
    venue_id: r.venue_id,
    day: r.day,
    start_ms: new Date(r.start_at).getTime(),
    end_ms: new Date(r.end_at).getTime(),
    status: r.status,
    hold_expires_ms: r.hold_expires_at ? new Date(r.hold_expires_at).getTime() : null,
    guest_keys: r.guest_keys ?? [],
    name_key: r.name_key,
    agent_key: r.agent_key,
    created_ms: new Date(r.created_at).getTime(),
    cancelled_ms: r.cancelled_at ? new Date(r.cancelled_at).getTime() : null,
    cancelled_from: r.cancelled_from,
    flags: r.flags ?? [],
  };
}

const lockKey = (venueId: string) => `openbooking:${venueId}#guard`;
const iso = (ms: number) => new Date(ms).toISOString();
