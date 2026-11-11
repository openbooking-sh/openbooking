/**
 * Idempotency for mutating calls.
 *
 * Semantics (aligned with UCP REST `Idempotency-Key`):
 *  - Same key + same request  → the original successful result is replayed; nothing runs twice.
 *  - Same key + different request → `idempotency_conflict` (UCP: HTTP 409).
 *  - Concurrent calls with the same key share a single in-flight execution. Across server
 *    instances that needs a store with `claim()`: the first instance to claim the key runs, the
 *    others wait for its result and replay it.
 *  - Only successes are stored. Failed calls change no state (providers must be atomic), so a retry
 *    after an error simply re-executes — e.g. confirm without consent, then with consent, same key.
 *  - A call that succeeded but whose result could not be stored fails too, after its `undo` has
 *    taken the change back: a retry would otherwise run a second time on top of the first.
 *  - Records are kept for at least 24h (UCP minimum).
 */
import { BookingError } from './errors';

export interface IdempotencyRecord {
  fingerprint: string;
  value: unknown;
  created_at: number;
}

/** Persistence for idempotency records. Swap the memory store for Redis/SQL in production. */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void>;
  /**
   * Claim `key` for a call that is about to run, so another instance sending the same key at the
   * same instant waits for it instead of running too. Resolves true when this caller now holds the
   * claim; false when a result is already recorded or another caller holds a live claim. The
   * claim expires after `ttlMs` (a crashed instance must not block a key for ever), and `set`
   * replaces it with the result. Optional: without it, concurrent calls are joined per process only.
   */
  claim?(key: string, fingerprint: string, ttlMs: number): Promise<boolean>;
  /** Give up a claim after a failed call, so a retry (or a waiting caller) can run. */
  release?(key: string): Promise<void>;
  /**
   * Delete every record whose key starts with `prefix` and resolve how many went. Optional: used
   * when a hosted business closes its account (its keys are prefixed with its id), because the
   * records hold copies of its bookings, customer details included.
   */
  deletePrefix?(prefix: string): Promise<number>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  readonly #claims = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const entry = this.#records.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#records.delete(key);
      return undefined;
    }
    return entry.record;
  }

  async set(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    this.#records.set(key, { record, expiresAt: this.#now() + ttlMs });
    this.#claims.delete(key);
  }

  async claim(key: string, _fingerprint: string, ttlMs: number): Promise<boolean> {
    if (await this.get(key)) return false;
    const held = this.#claims.get(key);
    if (held !== undefined && held > this.#now()) return false;
    this.#claims.set(key, this.#now() + ttlMs);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claims.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const key of [...this.#records.keys()]) {
      if (key.startsWith(prefix) && this.#records.delete(key)) n++;
    }
    return n;
  }
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claim blocks the same key on other instances if its holder never finishes. Longer
 * than any provider call should take; shorter than an agent would wait.
 */
const CLAIM_TTL_MS = 60_000;
/** How often a caller that lost the claim looks for the winner's result. */
const CLAIM_POLL_MS = 40;

/** Deterministic JSON (sorted keys) used to fingerprint requests. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

export class IdempotencyGuard {
  readonly #store: IdempotencyStore;
  readonly #ttlMs: number;
  readonly #inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<IdempotentResult<unknown>> }
  >();
  readonly #now: () => number;

  constructor(
    store: IdempotencyStore,
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
    now: () => number = Date.now,
  ) {
    this.#store = store;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /**
   * Run `fn` at most once per `key` for an identical `operation` + `request`.
   * `request` must exclude the idempotency key itself. `undo` takes back what `fn` did when its
   * result cannot be recorded; it runs before the key is given up, so no retry overlaps it.
   */
  async run<T>(
    key: string,
    operation: string,
    request: unknown,
    fn: () => Promise<T>,
    undo?: (value: T) => Promise<void>,
  ): Promise<IdempotentResult<T>> {
    const fingerprint = `${operation}:${stableStringify(request)}`;

    const pending = this.#inFlight.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw conflict(key);
      const { value } = await pending.promise;
      return { value: value as T, replayed: true };
    }

    // Register as in-flight synchronously (before any await) so concurrent callers with the same
    // key always join this execution instead of racing past the store lookup.
    const promise = (async (): Promise<IdempotentResult<T>> => {
      for (;;) {
        const existing = await this.#store.get(key);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw conflict(key);
          return { value: structuredClone(existing.value) as T, replayed: true };
        }
        if (!this.#store.claim) return this.#execute(key, fingerprint, fn, undo);
        // Another instance may be running this very key. Whoever claims it first runs; the rest
        // look again for its result. A failed run releases the claim, so one of the waiting
        // callers then runs (failures are never stored, so a retry re-executes).
        if (await this.#store.claim(key, fingerprint, CLAIM_TTL_MS)) {
          try {
            return await this.#execute(key, fingerprint, fn, undo);
          } finally {
            await this.#store.release?.(key).catch(() => undefined);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
      }
    })();
    this.#inFlight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #execute<T>(
    key: string,
    fingerprint: string,
    fn: () => Promise<T>,
    undo?: (value: T) => Promise<void>,
  ): Promise<IdempotentResult<T>> {
    const value = await fn();
    try {
      await this.#store.set(
        key,
        { fingerprint, value: structuredClone(value), created_at: this.#now() },
        this.#ttlMs,
      );
    } catch (e) {
      // Nothing is recorded for the key, so a retry runs again: it must not meet this run's work.
      await undo?.(value).catch(() => undefined);
      throw e;
    }
    return { value, replayed: false };
  }
}

function conflict(key: string): BookingError {
  return new BookingError(
    'idempotency_conflict',
    `idempotency_key "${key}" was already used for a different request.`,
  );
}
