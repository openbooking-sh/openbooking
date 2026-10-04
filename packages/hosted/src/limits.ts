/**
 * Rate limits for account endpoints (login, sign-up, password reset), so passwords can't be
 * guessed at speed and nobody can flood an inbox with reset emails.
 */
export interface RateLimiter {
  /** Count one attempt for `key`. False when more than `limit` attempts fall in the window. */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/**
 * Fixed windows in a Map. Per process: fine for one server; with several instances use the
 * Postgres limiter so the count is shared.
 */
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

const MIN = 60_000;

/** Attempts allowed per window. Generous for people, tight for scripts. */
export const LIMITS = {
  loginPerEmail: { limit: 10, windowMs: 15 * MIN },
  loginPerIp: { limit: 50, windowMs: 15 * MIN },
  signupPerIp: { limit: 10, windowMs: 60 * MIN },
  resetEmailPerEmail: { limit: 3, windowMs: 60 * MIN },
  resetEmailPerIp: { limit: 20, windowMs: 60 * MIN },
  resetSubmitPerIp: { limit: 20, windowMs: 15 * MIN },
} as const;

/**
 * The caller's IP from proxy headers. Vercel and most load balancers overwrite these, so they
 * can't be spoofed there. When running without a proxy, pass `clientIp` to createHostedApp.
 */
export function proxyClientIp(req: Request): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || 'unknown';
}
