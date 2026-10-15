/**
 * Who is calling a privileged operation (spec 10.1.6). Holds, bookings and anything carrying buyer
 * data MUST be authenticated; the catalog and availability may stay public.
 *
 * The router fails closed: without an authenticator every privileged operation answers 401. The
 * adapter ships no "trust everyone" default.
 */
import type { PlatformProfile } from './profile-fetch';

export interface UspPrincipal {
  /** Stable identity of the calling platform (for example the thumbprint of its proof key). */
  id: string;
  /** Set when the request presented a booking-scoped credential: what it may act on. */
  credential?: { scope: readonly string[] };
  /** The platform's profile, when profiles are fetched: what it says it can use. */
  platform?: PlatformProfile;
}

/** A booking-scoped credential as it goes on the wire (`profile.json#BookingScopedCredential`). */
export interface UspIssuedCredential {
  value: string;
  expires_at: string;
  /** Binds the credential to the caller's key, so a leaked value is useless on its own. */
  cnf?: { jkt: string };
  scope?: string[];
}

export interface UspAuthenticator {
  /** Mechanism identifiers for the profile's `authorization` policy, e.g. `platform_key_pop`. */
  readonly mechanisms: readonly string[];
  /**
   * Authenticate one request. Throw `ProtocolError('authentication_required', …)` (or a more
   * specific 401 code) when it cannot be. `rawBody` is the exact request body, for mechanisms
   * that sign it.
   */
  authenticate(request: Request, rawBody: string): Promise<UspPrincipal>;
  /**
   * Issue a credential for a hold or booking just created for `principal`. It is returned only on
   * the creation response, as a sibling of the hold or booking.
   */
  issueCredential?(
    principal: UspPrincipal,
    resource: { id: string; endsAt: Date },
  ): Promise<UspIssuedCredential | undefined>;
}

/**
 * Staff-only calls (such as confirming a booking in manual mode) must never be possible with a
 * platform credential. Return true only for the business's own authenticated staff.
 */
export type UspBusinessAuth = (request: Request) => boolean | Promise<boolean>;
