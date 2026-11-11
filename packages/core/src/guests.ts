/**
 * What a business keeps about its guests, apart from the booking itself.
 *
 * Two kinds of data, both staff-only. Neither is part of {@link Booking}, so no protocol adapter
 * (MCP, UCP, USP, A2A, booking page), notification, webhook, idempotency record or activity entry
 * can carry it by accident: the only way to read it is to ask this store.
 *
 *  - A dietary note (allergies, intolerances) belongs to one booking. It is health data under
 *    GDPR (art. 9), so it is kept only until a short while after the visit.
 *  - A guest profile (tags, staff notes, VIP) belongs to one guest of one business, under a key
 *    that is different for every business (see `guestKey` in @openbooking-sh/studio).
 *
 * Everything is scoped by `venue_id`; a hosted business's id is its venue id, so one business can
 * never read another's rows.
 */

/** Longest dietary note. It is a line for the kitchen, not a medical record. */
export const DIETARY_NOTE_MAX = 300;

/** How long after the visit ended a dietary note is kept. Short on purpose. */
export const DEFAULT_DIETARY_NOTE_RETENTION_DAYS = 1;

export interface DietaryNote {
  venue_id: string;
  booking_id: string;
  note: string;
  /** When the booked slot ends. The retention clock starts here. */
  visit_end: string;
}

export interface GuestProfile {
  tags: string[];
  /** Free text for staff ("prefers the corner table"). */
  notes: string;
  vip: boolean;
  updated_at: string;
}

export const MAX_GUEST_TAGS = 20;
export const MAX_GUEST_TAG_LENGTH = 40;
export const MAX_GUEST_NOTES_LENGTH = 2000;

export interface GuestStore {
  saveDietaryNote(note: DietaryNote): Promise<void>;
  /** Notes by booking id; bookings without one are absent from the map. */
  dietaryNotes(venueId: string, bookingIds: string[]): Promise<Map<string, string>>;
  deleteDietaryNotes(venueId: string, bookingIds: string[]): Promise<number>;
  /** Delete every note whose visit ended before `visitEndedBefore`. Resolves how many went. */
  purgeDietaryNotes(visitEndedBefore: Date, venueId?: string): Promise<number>;

  profiles(venueId: string, keys: string[]): Promise<Map<string, GuestProfile>>;
  /** Every profile of a business, for the guest list and for clean-up. */
  listProfiles(venueId: string): Promise<Map<string, GuestProfile>>;
  saveProfile(venueId: string, key: string, profile: GuestProfile): Promise<void>;
  deleteProfiles(venueId: string, keys: string[]): Promise<number>;

  /** Everything of one business (it closed its account). */
  deleteVenue(venueId: string): Promise<void>;
}

/** In memory: the default. A restart forgets it; hosted deployments use Postgres. */
export class MemoryGuestStore implements GuestStore {
  readonly #notes = new Map<string, DietaryNote>();
  readonly #profiles = new Map<string, GuestProfile>();

  async saveDietaryNote(n: DietaryNote): Promise<void> {
    this.#notes.set(`${n.venue_id}\0${n.booking_id}`, { ...n });
  }

  async dietaryNotes(venueId: string, bookingIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of bookingIds) {
      const n = this.#notes.get(`${venueId}\0${id}`);
      if (n) out.set(id, n.note);
    }
    return out;
  }

  async deleteDietaryNotes(venueId: string, bookingIds: string[]): Promise<number> {
    let n = 0;
    for (const id of bookingIds) if (this.#notes.delete(`${venueId}\0${id}`)) n++;
    return n;
  }

  async purgeDietaryNotes(before: Date, venueId?: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.#notes) {
      if (venueId && v.venue_id !== venueId) continue;
      if (new Date(v.visit_end).getTime() < before.getTime()) {
        this.#notes.delete(k);
        n++;
      }
    }
    return n;
  }

  async profiles(venueId: string, keys: string[]): Promise<Map<string, GuestProfile>> {
    const out = new Map<string, GuestProfile>();
    for (const key of keys) {
      const p = this.#profiles.get(`${venueId}\0${key}`);
      if (p) out.set(key, { ...p, tags: [...p.tags] });
    }
    return out;
  }

  async listProfiles(venueId: string): Promise<Map<string, GuestProfile>> {
    const out = new Map<string, GuestProfile>();
    const prefix = `${venueId}\0`;
    for (const [k, p] of this.#profiles) {
      if (k.startsWith(prefix)) out.set(k.slice(prefix.length), { ...p, tags: [...p.tags] });
    }
    return out;
  }

  async saveProfile(venueId: string, key: string, profile: GuestProfile): Promise<void> {
    this.#profiles.set(`${venueId}\0${key}`, { ...profile, tags: [...profile.tags] });
  }

  async deleteProfiles(venueId: string, keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.#profiles.delete(`${venueId}\0${key}`)) n++;
    return n;
  }

  async deleteVenue(venueId: string): Promise<void> {
    const prefix = `${venueId}\0`;
    for (const k of [...this.#notes.keys()]) if (k.startsWith(prefix)) this.#notes.delete(k);
    for (const k of [...this.#profiles.keys()]) if (k.startsWith(prefix)) this.#profiles.delete(k);
  }
}
