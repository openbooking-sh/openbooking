/**
 * Rate limits for account endpoints (login, sign-up, password reset), so passwords can't be
 * guessed at speed and nobody can flood an inbox with reset emails.
 */
// The limiter itself lives in core (the engine limits holds with it too).
export { MemoryRateLimiter, type RateLimiter } from '@openbooking-sh/core';
import { clientIpFromHeaders } from '@openbooking-sh/core';

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
  return clientIpFromHeaders(req.headers) ?? 'unknown';
}
