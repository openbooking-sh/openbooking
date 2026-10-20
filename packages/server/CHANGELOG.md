# @openbooking-sh/server

## 0.13.0

### Minor Changes

- 92f6c50: Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.
- 89789c9: USP over MCP. `createUsp({ mcp: true })` serves the spec's `usp_*` tools at `<path>/mcp` (a stateless Streamable HTTP MCP endpoint) and advertises it in the profile. It is the REST engine behind a different wrapper: same consent modes, idempotency, ownership, capability negotiation and state. Platforms authenticate with the MCP form of the key proof inside `_meta.usp.authorization`, results come back as `structuredContent` plus text, and protocol errors are JSON-RPC errors with `data.code`. Off by default: `usp: { mcp: true }` in the server, `uspMcp` in the hosted app.

  Also: `If-Match` (REST) and `_meta.usp.if_match` (MCP) on a booking write are now refused with `revision_mismatch` (412), because bookings carry no revision to match; REST used to ignore them.

- db42a3d: Add `usp` to `createOpenBookingApp`: mounts USP (`/usp`, `/.well-known/usp`) for assistants and platforms that book through the Universal Scheduling Protocol. Off unless set; by default the customer confirms on the booking page (`consent: 'action'`). Calls from USP platforms are credited to their own channel in Studio.

### Patch Changes

- e6a751c: Add the `booking.expired` webhook event, and an `expire` engine event, for holds that lapse without being confirmed or cancelled. Nothing runs when a hold expires, so the event is sent when a read first notices it or when `service.sweepExpired()` runs (call it from a cron or timer to report lapses nobody reads). Each expiry is announced at most once across instances through a new `expiryClaims` option (hosted reuses its email dedupe log; pass `PostgresNotificationLog` when running several instances on one database). The event carries no actor, and Studio shows it as a system entry.
- 787f01c: USP: platform profiles are now fetched (safely, public internet only) and capabilities negotiated. `usp.platformProfiles` on `createOpenBookingApp` and `uspPlatformProfiles` on `createHostedApp` take a fetcher or `false`; hosted shares one fetcher, and so one cache, across all businesses.
- Updated dependencies [3d98490]
- Updated dependencies [e6a751c]
- Updated dependencies [5b1fb9a]
- Updated dependencies [3825c49]
- Updated dependencies [92f6c50]
- Updated dependencies [db42a3d]
- Updated dependencies [db42a3d]
- Updated dependencies [89789c9]
- Updated dependencies [787f01c]
- Updated dependencies [db42a3d]
  - @openbooking-sh/booking-page@0.13.0
  - @openbooking-sh/core@0.13.0
  - @openbooking-sh/studio@0.13.0
  - @openbooking-sh/adapter-usp@0.13.0
  - @openbooking-sh/adapter-a2a@0.13.0
  - @openbooking-sh/adapter-mcp@0.13.0
  - @openbooking-sh/adapter-ucp@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0
  - @openbooking-sh/studio@0.12.0
  - @openbooking-sh/adapter-a2a@0.12.0
  - @openbooking-sh/adapter-mcp@0.12.0
  - @openbooking-sh/adapter-ucp@0.12.0
  - @openbooking-sh/booking-page@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [10e30b3]
  - @openbooking-sh/studio@0.11.0
  - @openbooking-sh/booking-page@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [7fdf84e]
- Updated dependencies [12ec3a2]
  - @openbooking-sh/studio@0.10.0
  - @openbooking-sh/core@0.10.0
  - @openbooking-sh/adapter-mcp@0.10.0
  - @openbooking-sh/adapter-a2a@0.10.0
  - @openbooking-sh/adapter-ucp@0.10.0
  - @openbooking-sh/booking-page@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [dd48af2]
- Updated dependencies [c766b13]
- Updated dependencies [dfb5e56]
- Updated dependencies [e2d4873]
- Updated dependencies [eb99a97]
  - @openbooking-sh/core@0.9.0
  - @openbooking-sh/studio@0.9.0
  - @openbooking-sh/booking-page@0.9.0
  - @openbooking-sh/adapter-a2a@0.9.0
  - @openbooking-sh/adapter-mcp@0.9.0
  - @openbooking-sh/adapter-ucp@0.9.0

## 0.7.0

### Minor Changes

- 660944c: Implement the A2A `SendMessage` endpoint (`createA2AAdapter`). A2A agents can now search, hold, confirm and cancel bookings through the same BookingService as MCP and UCP. `createA2AStub` is removed.
- 783a56e: Webhooks: `createWebhooks()` (core) and the `webhooks` option of `createOpenBookingApp` send signed `booking.held`, `.confirmed`, `.updated` and `.cancelled` events with retries; `verifyWebhook()` checks them on the receiving side. Replays and no-op cancels don't send events (`BookingEvent.unchanged` marks the latter).

### Patch Changes

- Updated dependencies [660944c]
- Updated dependencies [7c9ad2d]
- Updated dependencies [e4b56d6]
- Updated dependencies [783a56e]
- Updated dependencies [671f98e]
  - @openbooking-sh/adapter-a2a@0.7.0
  - @openbooking-sh/core@0.7.0
  - @openbooking-sh/adapter-mcp@0.7.0
  - @openbooking-sh/booking-page@0.7.0
  - @openbooking-sh/adapter-ucp@0.7.0
  - @openbooking-sh/studio@0.7.0

## 0.6.0

### Patch Changes

- 899afde: The business root (`/`) serves the booking page unless the client asks for JSON, so AI crawlers that send `Accept: */*` see the business and its schema.org data. Adds `Vary: Accept`.

## 0.2.0

### Minor Changes

- 4d9f0fc: Better for agents and safer in public, from a fresh-eyes test of the SDK:

  - New MCP tool `get_business_info`: services, staff, opening hours and booking window.
  - Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
  - `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
  - New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
  - Providers can expose opening hours with `getVenueInfo`.

### Patch Changes

- Updated dependencies [4d9f0fc]
  - @openbooking-sh/core@0.2.0
  - @openbooking-sh/adapter-mcp@0.2.0
  - @openbooking-sh/studio@0.2.0
  - @openbooking-sh/booking-page@0.2.0
  - @openbooking-sh/adapter-a2a@0.2.0
  - @openbooking-sh/adapter-ucp@0.2.0
