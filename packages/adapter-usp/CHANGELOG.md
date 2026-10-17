# @openbooking-sh/adapter-usp

## 0.13.0

### Minor Changes

- db42a3d: First release of the USP adapter: the Universal Scheduling Protocol (a draft standard from Wix and Stripe) over REST. Profile at `/.well-known/usp`, catalog, availability, holds and bookings. Platforms sign in with a key they make themselves (RFC 9449 DPoP proofs, no accounts), booking credentials are bound to that key, and each business chooses how a booking becomes real: the customer confirms on the booking page (default) or the assistant books immediately. `createUsp()` wires it for one business. Follows a draft spec and may change with it.
- 787f01c: Fetch and check platform profiles. On a privileged call the platform's profile (named in `USP-Agent`) is fetched with a hardened fetcher that can only reach the public internet (https on 443 to a host name, every DNS answer must be public, the connection goes to the validated address with TLS checked against the host name, no redirects, time and size limits, cached for the profile's `Cache-Control`), and the business uses only the capabilities both sides have: `version_unsupported` for a newer platform, `capabilities_incompatible` when nothing is usable. `createUsp({ platformProfiles })` takes your own fetcher or `false`; the default is the hardened one. `createPopAuthenticator({ fetchProfile })` replaces `checkProfile`.

### Patch Changes

- Updated dependencies [db42a3d]
  - @openbooking-sh/core@0.13.0
