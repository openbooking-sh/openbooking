# @openbooking-sh/adapter-usp

## 0.13.0

### Minor Changes

- db42a3d: First release of the USP adapter: the Universal Scheduling Protocol (a draft standard from Wix and Stripe) over REST. Profile at `/.well-known/usp`, catalog, availability, holds and bookings. Platforms sign in with a key they make themselves (RFC 9449 DPoP proofs, no accounts), booking credentials are bound to that key, and each business chooses how a booking becomes real: the customer confirms on the booking page (default) or the assistant books immediately. `createUsp()` wires it for one business. Follows a draft spec and may change with it.
- 89789c9: USP over MCP. `createUsp({ mcp: true })` serves the spec's `usp_*` tools at `<path>/mcp` (a stateless Streamable HTTP MCP endpoint) and advertises it in the profile. It is the REST engine behind a different wrapper: same consent modes, idempotency, ownership, capability negotiation and state. Platforms authenticate with the MCP form of the key proof inside `_meta.usp.authorization`, results come back as `structuredContent` plus text, and protocol errors are JSON-RPC errors with `data.code`. Off by default: `usp: { mcp: true }` in the server, `uspMcp` in the hosted app.

  Also: `If-Match` (REST) and `_meta.usp.if_match` (MCP) on a booking write are now refused with `revision_mismatch` (412), because bookings carry no revision to match; REST used to ignore them.

- 787f01c: Fetch and check platform profiles. On a privileged call the platform's profile (named in `USP-Agent`) is fetched with a hardened fetcher that can only reach the public internet (https on 443 to a host name, every DNS answer must be public, the connection goes to the validated address with TLS checked against the host name, no redirects, time and size limits, cached for the profile's `Cache-Control`), and the business uses only the capabilities both sides have: `version_unsupported` for a newer platform, `capabilities_incompatible` when nothing is usable. `createUsp({ platformProfiles })` takes your own fetcher or `false`; the default is the hardened one. `createPopAuthenticator({ fetchProfile })` replaces `checkProfile`.

### Patch Changes

- Updated dependencies [e6a751c]
- Updated dependencies [3825c49]
- Updated dependencies [db42a3d]
  - @openbooking-sh/core@0.13.0
