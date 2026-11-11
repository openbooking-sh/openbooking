/**
 * Guest profiles and the pre-shift summary: staff-only views over one business's own bookings.
 *
 * Who is "the same guest": the normalised email address (or, without one, the phone number's
 * digits), hashed together with the business's id. Why:
 *  - the hash includes the business id, so the key differs per business: two businesses cannot
 *    link a guest, and no cross-business lookup exists even by accident;
 *  - the profile table holds no email address or phone number, only this key;
 *  - the key is stable, so a guest booking again (or through another channel) is recognised;
 *  - erasing a customer recomputes the key from the bookings found for their email or phone.
 * It is pseudonymous, not anonymous: an address can be guessed and hashed. Profiles are therefore
 * still personal data, removed on erasure and when no booking with that guest remains.
 */
import { createHash } from 'node:crypto';
import {
  MAX_GUEST_NOTES_LENGTH,
  MAX_GUEST_TAGS,
  MAX_GUEST_TAG_LENGTH,
  time,
  type Booking,
  type GuestProfile,
  type GuestStore,
} from '@openbooking-sh/core';
import * as z from 'zod';

type Who = { email?: string | undefined; phone_number?: string | undefined } | null | undefined;

const digest = (venueId: string, kind: string, value: string) =>
  createHash('sha256').update(`openbooking:guest:v1\0${venueId}\0${kind}\0${value}`).digest('hex');

/** Keys a customer can be known by: email first, then phone (digits only, at least 6). */
export function guestKeys(venueId: string, who: Who): string[] {
  const keys: string[] = [];
  const email = who?.email?.trim().toLowerCase();
  if (email) keys.push(digest(venueId, 'email', email));
  const phone = (who?.phone_number ?? '').replace(/\D/g, '');
  if (phone.length >= 6) keys.push(digest(venueId, 'phone', phone));
  return keys;
}

/** The key a guest's profile is stored under, or null when the booking names nobody. */
export function guestKey(venueId: string, who: Who): string | null {
  return guestKeys(venueId, who)[0] ?? null;
}

/** What staff may set on a profile. Free text is capped; tags are short, unique labels. */
export const GuestProfileInputSchema = z.object({
  tags: z
    .array(z.string().trim().min(1).max(MAX_GUEST_TAG_LENGTH))
    .max(MAX_GUEST_TAGS)
    .transform((t) => [...new Set(t)]),
  notes: z.string().max(MAX_GUEST_NOTES_LENGTH),
  vip: z.boolean(),
});
export type GuestProfileInput = z.infer<typeof GuestProfileInputSchema>;

export const EMPTY_PROFILE: GuestProfile = { tags: [], notes: '', vip: false, updated_at: '' };

export function hasProfileData(p: GuestProfile | undefined): p is GuestProfile {
  return !!p && (p.vip || p.tags.length > 0 || p.notes.trim() !== '');
}

export interface GuestHistory {
  /** Confirmed bookings that already started. */
  visits: number;
  first_visit: string | null;
  last_visit: string | null;
  next_visit: string | null;
  /** The guest's last bookings, newest first. */
  recent: {
    booking_id: string;
    start: string;
    party_size: number;
    status: Booking['status'];
  }[];
}

/** A guest's history from the business's own bookings. Bookings must be of one business. */
export function guestHistory(
  bookings: Booking[],
  venueId: string,
  key: string,
  now: Date,
): GuestHistory {
  const mine = bookings.filter((b) => guestKeys(venueId, b.customer).includes(key));
  const nowIso = now.toISOString();
  const confirmed = mine.filter((b) => b.status === 'confirmed');
  const past = confirmed.filter((b) => b.slot.start < nowIso).map((b) => b.slot.start);
  const ahead = confirmed.filter((b) => b.slot.start >= nowIso).map((b) => b.slot.start);
  return {
    visits: past.length,
    first_visit: past.length ? past.reduce((a, b) => (a < b ? a : b)) : null,
    last_visit: past.length ? past.reduce((a, b) => (a > b ? a : b)) : null,
    next_visit: ahead.length ? ahead.reduce((a, b) => (a < b ? a : b)) : null,
    recent: [...mine]
      .sort((a, b) => (a.slot.start < b.slot.start ? 1 : -1))
      .slice(0, 8)
      .map((b) => ({
        booking_id: b.booking_id,
        start: b.slot.start,
        party_size: b.slot.party_size.total,
        status: b.status,
      })),
  };
}

export interface PreshiftEntry {
  booking_id: string;
  start: string;
  end: string;
  party_size: number;
  resource: string | null;
  guest: string | null;
  first_time: boolean;
  /** Earlier visits of this guest. */
  previous_visits: number;
  vip: boolean;
  tags: string[];
  staff_notes: string;
  /** Allergies and dietary needs the guest gave. Staff only; gone shortly after the visit. */
  dietary_note: string | null;
  /** The booking's own notes (what the guest or agent wrote as a general request). */
  notes: string | null;
}

export interface Preshift {
  date: string;
  timezone: string;
  bookings: number;
  covers: number;
  /** Party size to number of bookings, e.g. { "2": 5, "4": 2 }. */
  party_sizes: Record<string, number>;
  vips: number;
  first_time: number;
  returning: number;
  with_dietary_notes: number;
  entries: PreshiftEntry[];
}

/**
 * The staff briefing for one day: who is coming, how many, who is a VIP or new, and what they
 * told us about allergies. `all` is every booking of the business, used to tell new from
 * returning guests; only confirmed bookings of `date` are listed.
 */
export async function buildPreshift(options: {
  all: Booking[];
  date: string;
  timezone: string;
  guests: GuestStore;
}): Promise<Preshift> {
  const { all, date, timezone, guests } = options;
  const day = all
    .filter(
      (b) => b.status === 'confirmed' && time.localDate(new Date(b.slot.start), timezone) === date,
    )
    .sort((a, b) => (a.slot.start < b.slot.start ? -1 : 1));

  // Who has been confirmed before, by key and first start: new vs returning is decided per booking.
  const confirmed = all.filter((b) => b.status === 'confirmed');
  const venueOf = (b: Booking) => b.venue_id;
  const starts = new Map<string, string[]>();
  for (const b of confirmed) {
    for (const k of guestKeys(venueOf(b), b.customer)) {
      starts.set(k, [...(starts.get(k) ?? []), b.slot.start]);
    }
  }

  const venueIds = [...new Set(day.map(venueOf))];
  const profiles = new Map<string, GuestProfile>();
  const notes = new Map<string, string>();
  for (const v of venueIds) {
    const ofVenue = day.filter((b) => venueOf(b) === v);
    const keys = ofVenue.flatMap((b) => guestKeys(v, b.customer));
    for (const [k, p] of await guests.profiles(v, keys)) profiles.set(k, p);
    for (const [id, n] of await guests.dietaryNotes(
      v,
      ofVenue.map((b) => b.booking_id),
    )) {
      notes.set(id, n);
    }
  }

  const party_sizes: Record<string, number> = {};
  const entries: PreshiftEntry[] = day.map((b) => {
    const keys = guestKeys(venueOf(b), b.customer);
    const profile = keys.map((k) => profiles.get(k)).find(hasProfileData);
    const before = keys.length
      ? Math.max(...keys.map((k) => (starts.get(k) ?? []).filter((s) => s < b.slot.start).length))
      : 0;
    const size = b.slot.party_size.total;
    party_sizes[String(size)] = (party_sizes[String(size)] ?? 0) + 1;
    return {
      booking_id: b.booking_id,
      start: b.slot.start,
      end: b.slot.end,
      party_size: size,
      resource: b.slot.resource?.label ?? null,
      guest: b.customer ? `${b.customer.first_name} ${b.customer.last_name}` : null,
      first_time: before === 0,
      previous_visits: before,
      vip: !!profile?.vip,
      tags: profile?.tags ?? [],
      staff_notes: profile?.notes ?? '',
      dietary_note: notes.get(b.booking_id) ?? null,
      notes: b.notes,
    };
  });

  return {
    date,
    timezone,
    bookings: entries.length,
    covers: entries.reduce((n, e) => n + e.party_size, 0),
    party_sizes,
    vips: entries.filter((e) => e.vip).length,
    first_time: entries.filter((e) => e.first_time).length,
    returning: entries.filter((e) => !e.first_time).length,
    with_dietary_notes: entries.filter((e) => e.dietary_note).length,
    entries,
  };
}

/**
 * Remove profiles of guests the business holds no booking details for any more (the retention
 * clean-up removed their names and contacts), so a pseudonymous profile never outlives the
 * bookings it describes. Resolves how many went.
 */
export async function pruneGuestProfiles(
  guests: GuestStore,
  venueId: string,
  bookings: Booking[],
): Promise<number> {
  const live = new Set(bookings.flatMap((b) => guestKeys(venueId, b.customer)));
  const orphans = [...(await guests.listProfiles(venueId)).keys()].filter((k) => !live.has(k));
  return orphans.length ? guests.deleteProfiles(venueId, orphans) : 0;
}

/**
 * Whether a booking belongs to the person a request names: same email (any case) or same phone
 * digits. Mirrors the booking stores' own matching, so a profile is found for exactly the
 * bookings an erasure is about to clean.
 */
export function matchesPerson(
  booking: Booking,
  who: { email?: string | undefined; phone?: string | undefined },
): boolean {
  const c = booking.customer;
  if (!c) return false;
  const email = who.email?.trim().toLowerCase();
  const phone = (who.phone ?? '').replace(/\D/g, '');
  return (
    (!!email && c.email?.toLowerCase() === email) ||
    (phone.length >= 6 && !!c.phone_number && c.phone_number.replace(/\D/g, '') === phone)
  );
}
