/**
 * Fixed-window rate limiting, shared by the engine (holds) and hosted (logins, sign-ups).
 * Memory by default; `@openbooking-sh/postgres` has a limiter shared across server instances.
 */
export interface RateLimiter {
  /** Count one attempt for `key`. False when more than `limit` attempts fall in the window. */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** Fixed windows in a Map, per process. */
export class MemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = this.#now();
    const w = this.#windows.get(key);
    if (!w || w.start + windowMs <= now) {
      this.#windows.set(key, { start: now, count: 1 });
      if (this.#windows.size > 10_000) this.#prune(now, windowMs);
      return 1 <= limit;
    }
    w.count++;
    return w.count <= limit;
  }

  #prune(now: number, windowMs: number): void {
    for (const [k, w] of this.#windows) if (w.start + windowMs <= now) this.#windows.delete(k);
  }
}

/**
 * The caller's IP from proxy headers (x-real-ip, then the first x-forwarded-for entry). Vercel and
 * most load balancers overwrite these, so they can't be spoofed there.
 */
export function clientIpFromHeaders(headers: Headers): string | undefined {
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || undefined;
}
