import type { DietaryNote, GuestProfile, GuestStore } from '@openbooking-sh/core';
import type { Db } from './db';

interface ProfileRow {
  guest_key: string;
  tags: string[];
  notes: string;
  vip: boolean;
  updated_at: Date | string;
}

const toProfile = (r: ProfileRow): GuestProfile => ({
  tags: r.tags,
  notes: r.notes,
  vip: r.vip,
  updated_at: new Date(r.updated_at).toISOString(),
});

/**
 * Dietary notes and guest profiles in Postgres (see `GuestStore` in @openbooking-sh/core). Every
 * query names the venue (a hosted business's id), so one business never reads another's rows; the
 * tables also have row level security on, like every other table.
 */
export class PostgresGuestStore implements GuestStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async saveDietaryNote(n: DietaryNote): Promise<void> {
    await this.#db.query(
      `insert into ob_dietary_notes (venue_id, booking_id, note, visit_end)
       values ($1, $2, $3, $4::timestamptz)
       on conflict (venue_id, booking_id) do update set note = excluded.note, visit_end = excluded.visit_end`,
      [n.venue_id, n.booking_id, n.note, n.visit_end],
    );
  }

  async dietaryNotes(venueId: string, bookingIds: string[]): Promise<Map<string, string>> {
    if (!bookingIds.length) return new Map();
    const { rows } = await this.#db.query<{ booking_id: string; note: string }>(
      'select booking_id, note from ob_dietary_notes where venue_id = $1 and booking_id = any($2::text[])',
      [venueId, bookingIds],
    );
    return new Map(rows.map((r) => [r.booking_id, r.note]));
  }

  async deleteDietaryNotes(venueId: string, bookingIds: string[]): Promise<number> {
    if (!bookingIds.length) return 0;
    const { rows } = await this.#db.query(
      'delete from ob_dietary_notes where venue_id = $1 and booking_id = any($2::text[]) returning booking_id',
      [venueId, bookingIds],
    );
    return rows.length;
  }

  async purgeDietaryNotes(before: Date, venueId?: string): Promise<number> {
    const { rows } = await this.#db.query(
      `delete from ob_dietary_notes
        where visit_end < $1::timestamptz and ($2::text is null or venue_id = $2)
        returning booking_id`,
      [before.toISOString(), venueId ?? null],
    );
    return rows.length;
  }

  async profiles(venueId: string, keys: string[]): Promise<Map<string, GuestProfile>> {
    if (!keys.length) return new Map();
    const { rows } = await this.#db.query<ProfileRow>(
      `select guest_key, tags, notes, vip, updated_at from ob_guest_profiles
        where venue_id = $1 and guest_key = any($2::text[])`,
      [venueId, keys],
    );
    return new Map(rows.map((r) => [r.guest_key, toProfile(r)]));
  }

  async listProfiles(venueId: string): Promise<Map<string, GuestProfile>> {
    const { rows } = await this.#db.query<ProfileRow>(
      'select guest_key, tags, notes, vip, updated_at from ob_guest_profiles where venue_id = $1',
      [venueId],
    );
    return new Map(rows.map((r) => [r.guest_key, toProfile(r)]));
  }

  async saveProfile(venueId: string, key: string, p: GuestProfile): Promise<void> {
    await this.#db.query(
      `insert into ob_guest_profiles (venue_id, guest_key, tags, notes, vip, updated_at)
       values ($1, $2, $3::text[], $4, $5, $6::timestamptz)
       on conflict (venue_id, guest_key) do update
         set tags = excluded.tags, notes = excluded.notes, vip = excluded.vip,
             updated_at = excluded.updated_at`,
      [venueId, key, p.tags, p.notes, p.vip, p.updated_at],
    );
  }

  async deleteProfiles(venueId: string, keys: string[]): Promise<number> {
    if (!keys.length) return 0;
    const { rows } = await this.#db.query(
      'delete from ob_guest_profiles where venue_id = $1 and guest_key = any($2::text[]) returning guest_key',
      [venueId, keys],
    );
    return rows.length;
  }

  async deleteVenue(venueId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.query('delete from ob_dietary_notes where venue_id = $1', [venueId]);
      await tx.query('delete from ob_guest_profiles where venue_id = $1', [venueId]);
    });
  }
}
