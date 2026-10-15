/**
 * What the adapter has to remember that the booking engine does not: which calling platform owns
 * a hold or booking (so one platform can never act on another's), and which holds became bookings
 * (USP lets a hold be "converted"; for us the hold and the booking are the same record).
 *
 * In memory by default. A deployment that restarts or runs several instances needs a durable
 * store, or owners and conversions are forgotten: bookings stay safe in the engine, but the
 * platform that made them could no longer read or change them.
 */
import type { PopCredential } from './pop';

export interface UspStateStore {
  /** Record who owns a hold/booking. First claim wins; later claims by another principal fail. */
  claim(bookingId: string, principal: string): Promise<boolean>;
  ownerOf(bookingId: string): Promise<string | undefined>;
  /** A booking was created from this hold (or directly): reads of it now count as a booking. */
  markBooking(bookingId: string): Promise<void>;
  isBooking(bookingId: string): Promise<boolean>;
  /**
   * Remember what request an Idempotency-Key was first used for. True for a new key or the same
   * request again; false when the key is reused for a different request (a 409 for the caller).
   */
  checkKey(scopedKey: string, fingerprint: string): Promise<boolean>;
  /** Booking-scoped credentials, kept by hash so the value itself is never stored. */
  saveCredential(credential: PopCredential): Promise<void>;
  findCredential(hash: string): Promise<PopCredential | undefined>;
  /** True if this proof `jti` was already seen; records it otherwise (kept for `ttlMs`). */
  seenJti(jti: string, ttlMs: number): Promise<boolean>;
  /**
   * Trust on first use: tie a platform key to the profile URI it first presented. True for a new
   * key or the same profile again; false when that key shows up with a different profile.
   */
  bindProfile(jkt: string, profileUri: string): Promise<boolean>;
}

export class MemoryUspState implements UspStateStore {
  constructor(private readonly now: () => number = Date.now) {}
  readonly #credentials = new Map<string, PopCredential>();
  readonly #jtis = new Map<string, number>();
  readonly #profiles = new Map<string, string>();
  readonly #owners = new Map<string, string>();
  readonly #bookings = new Set<string>();
  readonly #keys = new Map<string, string>();

  async claim(bookingId: string, principal: string): Promise<boolean> {
    const owner = this.#owners.get(bookingId);
    if (owner !== undefined) return owner === principal;
    this.#owners.set(bookingId, principal);
    return true;
  }
  async ownerOf(bookingId: string) {
    return this.#owners.get(bookingId);
  }
  async markBooking(bookingId: string) {
    this.#bookings.add(bookingId);
  }
  async isBooking(bookingId: string) {
    return this.#bookings.has(bookingId);
  }
  async saveCredential(credential: PopCredential) {
    // Never overwrite: a stored credential's scope and key binding must not be changeable.
    if (!this.#credentials.has(credential.hash)) this.#credentials.set(credential.hash, credential);
  }
  async findCredential(hash: string) {
    return this.#credentials.get(hash);
  }
  async seenJti(jti: string, ttlMs: number) {
    const now = this.now();
    for (const [k, until] of this.#jtis) if (until <= now) this.#jtis.delete(k);
    if (this.#jtis.has(jti)) return true;
    this.#jtis.set(jti, now + ttlMs);
    return false;
  }
  async bindProfile(jkt: string, profileUri: string) {
    const bound = this.#profiles.get(jkt);
    if (bound !== undefined) return bound === profileUri;
    this.#profiles.set(jkt, profileUri);
    return true;
  }
  async checkKey(scopedKey: string, fingerprint: string) {
    const seen = this.#keys.get(scopedKey);
    if (seen !== undefined) return seen === fingerprint;
    // Bounded: the oldest keys go first (Map keeps insertion order).
    if (this.#keys.size >= 10_000) this.#keys.delete(this.#keys.keys().next().value!);
    this.#keys.set(scopedKey, fingerprint);
    return true;
  }
}
