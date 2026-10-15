/**
 * Capability negotiation (spec 8.3 and 8.4): the business works out which capabilities both sides
 * have and uses only those. There is no handshake; the platform's profile says what it can use.
 */
import { USP, USP_VERSION } from './constants';
import type { PlatformProfile } from './profile-fetch';

/** What this adapter can serve, and the versions it speaks of each (key → versions). */
export const BUSINESS_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  [USP.catalog]: [USP_VERSION],
  [USP.availability]: [USP_VERSION],
  [USP.bookings]: [USP_VERSION],
};

export type Negotiation =
  /** The platform speaks a newer protocol than we do: tell it the latest we support. */
  | { kind: 'version_unsupported'; latest: string }
  /** No capability in common: a valid request, but nothing it can use here. */
  | { kind: 'incompatible' }
  /** The capabilities both sides have, each at the highest version they share. */
  | { kind: 'ok'; capabilities: Record<string, string> };

export function negotiate(
  platform: PlatformProfile,
  business: Readonly<Record<string, readonly string[]>> = BUSINESS_CAPABILITIES,
): Negotiation {
  const latest = Object.values(business).flat().sort().at(-1) ?? USP_VERSION;
  // Date versions sort as text. A platform newer than us may expect things we do not do.
  if (platform.usp.version > latest) return { kind: 'version_unsupported', latest };

  const capabilities: Record<string, string> = {};
  for (const [key, mine] of Object.entries(business)) {
    const theirs = platform.usp.capabilities[key]?.map((c) => c.version) ?? [];
    const shared = mine.filter((v) => theirs.includes(v)).sort();
    if (shared.length) capabilities[key] = shared.at(-1)!;
  }
  return Object.keys(capabilities).length ? { kind: 'ok', capabilities } : { kind: 'incompatible' };
}
