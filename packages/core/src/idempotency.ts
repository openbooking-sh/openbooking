/**
 * Idempotency for mutating calls.
 *
 * Semantics (aligned with UCP REST `Idempotency-Key`):
 *  - Same key + same request  → the original successful result is replayed; nothing runs twice.
 *  - Same key + different request → `idempotency_conflict` (UCP: HTTP 409).
 *  - Concurrent calls with the same key share a single in-flight execution.
 *  - Only successes are stored. Failed calls change no state (providers must be atomic), so a retry
 *    after an error simply re-executes — e.g. confirm without consent, then with consent, same key.
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
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
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
  }
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
   * `request` must exclude the idempotency key itself.
   */
  async run<T>(
    key: string,
    operation: string,
    request: unknown,
    fn: () => Promise<T>,
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
      const existing = await this.#store.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw conflict(key);
        return { value: structuredClone(existing.value) as T, replayed: true };
      }
      const value = await fn();
      await this.#store.set(
        key,
        { fingerprint, value: structuredClone(value), created_at: this.#now() },
        this.#ttlMs,
      );
      return { value, replayed: false };
    })();
    this.#inFlight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(key);
    }
  }
}

function conflict(key: string): BookingError {
  return new BookingError(
    'idempotency_conflict',
    `idempotency_key "${key}" was already used for a different request.`,
  );
}
