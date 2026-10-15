/**
 * USP for one business in one call: the REST router, the authenticator that checks platforms'
 * proofs, and the profile document, wired together the way a server mounts them.
 *
 *   const usp = createUsp({ service, baseUrl, continueUrl: page.confirmUrl, bookingUrl: page.manageUrl });
 *   app.route(usp.path, usp.router);
 *   app.get('/.well-known/usp', async (c) => c.json(await usp.profile()));
 */
import type { Booking, BookingService } from '@openbooking-sh/core';
import type { Hono } from 'hono';
import type { UspBusinessAuth } from './auth';
import type { ConsentMode } from './booking-mapping';
import { createPopAuthenticator } from './pop-auth';
import { createProfileFetcher, type ProfileFetcher } from './profile-fetch';
import { buildUspProfileFor } from './profile';
import { createUspRouter } from './router';
import { MemoryUspState, type UspStateStore } from './state';

export interface UspOptions {
  service: BookingService;
  /**
   * Where this business is reached, with no trailing slash and including any path prefix, e.g.
   * `https://app.openbooking.sh/b/studio-nord`. Platforms sign the exact URL they call
   * (`baseUrl + path + route`), so this must be the public address, not the one a proxy forwards.
   */
  baseUrl: string;
  /** Mount path of the router under `baseUrl`. Default `/usp`. */
  path?: string;
  /** Stable id of the business in USP `Service.business_id`. Default: the host of `baseUrl`. */
  businessId?: string;
  /** How a booking becomes real: the buyer confirms on a page (default), or it commits at once. */
  consent?: ConsentMode;
  /** Where the buyer confirms a held booking. Required for consent `action`. */
  continueUrl?: (booking: Booking) => string;
  bookingUrl?: (booking: Booking) => string | undefined;
  /** Owners, credentials, replay memory. Default in memory: use Postgres across instances. */
  state?: UspStateStore;
  businessAuth?: UspBusinessAuth;
  /**
   * How platform profiles are fetched (spec 8.2.3). Default: a hardened fetcher that only reaches
   * the public internet (see `createProfileFetcher`). Pass your own to share its cache between
   * businesses, or `false` to not fetch profiles at all (no capability negotiation: for local
   * development and tests).
   */
  platformProfiles?: ProfileFetcher | false;
  /** Display name in the profile. Default: the booking system's name. */
  name?: string;
}

export type UspProfile = Awaited<ReturnType<typeof buildUspProfileFor>>;

export interface Usp {
  router: Hono;
  path: string;
  /** The `/.well-known/usp` document. */
  profile(): Promise<UspProfile>;
}

export function createUsp(options: UspOptions): Usp {
  const { service } = options;
  const base = options.baseUrl.replace(/\/+$/, '');
  const path = options.path ?? '/usp';
  const state = options.state ?? new MemoryUspState(() => service.clock.now().getTime());
  const auth = createPopAuthenticator({
    baseUrl: base,
    state,
    clock: service.clock,
    ...(options.platformProfiles === false
      ? {}
      : { fetchProfile: options.platformProfiles ?? createProfileFetcher() }),
    // The URL a platform signed is the public one; a proxy may have stripped a prefix from the
    // request we see (hosted serves each business under /b/<id>), so build it from `baseUrl`.
    htu: (request) => `${base}${new URL(request.url).pathname}`,
  });
  const router = createUspRouter({
    service,
    baseUrl: base,
    consent: options.consent ?? 'action',
    auth,
    state,
    ...(options.businessId ? { businessId: options.businessId } : {}),
    ...(options.continueUrl ? { continueUrl: options.continueUrl } : {}),
    ...(options.bookingUrl ? { bookingUrl: options.bookingUrl } : {}),
    ...(options.businessAuth ? { businessAuth: options.businessAuth } : {}),
  });
  return {
    router,
    path,
    profile: () =>
      buildUspProfileFor(service, {
        baseUrl: base,
        uspPath: path,
        bookings: { mechanisms: auth.mechanisms },
        ...(options.name ? { name: options.name } : {}),
      }),
  };
}
