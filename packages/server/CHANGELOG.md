# @openbooking-sh/server

## 0.13.0

### Minor Changes

- 45b5786: Age rules on hosted. Sign-up says you must be 18 or older to create an account, and every hosted booking page shows a notice above the confirm button for bookings made on behalf of a child (a parent or guardian books, with the child's name in the notes). For your own deployment the notice is an option and off by default: `childNotice` on the booking page (and `bookingPage.childNotice` in the server).
- 92f6c50: Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.
- 3faa27f: Announce lapsed holds without anyone having to look at them. `server` gets an opt-in `sweepExpiredEveryMs` option that runs `service.sweepExpired()` on a timer (long-running processes; the timer never keeps the process alive and stops on `close()`). `hosted` gets `GET /api/maintenance/sweep` and `hosted.sweepExpiredHolds()`, protected by the same `CRON_SECRET` as the purge endpoint, and the daily purge now also sweeps, so `booking.expired` and its emails go out even on a daily cron. For minute-level timeliness, point a more frequent cron at `/api/maintenance/sweep` (Vercel Hobby only allows daily crons).
- 89789c9: USP over MCP. `createUsp({ mcp: true })` serves the spec's `usp_*` tools at `<path>/mcp` (a stateless Streamable HTTP MCP endpoint) and advertises it in the profile. It is the REST engine behind a different wrapper: same consent modes, idempotency, ownership, capability negotiation and state. Platforms authenticate with the MCP form of the key proof inside `_meta.usp.authorization`, results come back as `structuredContent` plus text, and protocol errors are JSON-RPC errors with `data.code`. Off by default: `usp: { mcp: true }` in the server, `uspMcp` in the hosted app.

  Also: `If-Match` (REST) and `_meta.usp.if_match` (MCP) on a booking write are now refused with `revision_mismatch` (412), because bookings carry no revision to match; REST used to ignore them.

- b598d10: More ways for a platform to authenticate to USP, all opt in through `createUsp({ platformAuth })` (and `usp: { platformAuth }` in the server). The default is unchanged: Ed25519 key proofs only.

  - `proofAlgorithms: ['EdDSA', 'ES256']` also accepts P-256 proof keys for `platform_key_pop` (EdDSA stays the floor).
  - `nonces: { secret }` makes a business require a server-issued nonce in every proof. A platform without one gets `proof_nonce_required` with the nonce (`DPoP-Nonce` header, or `data.nonce` over MCP) and retries.
  - `httpSignatures: true` accepts RFC 9421 HTTP Message Signatures on REST (`ES256`): the platform signs with a key it publishes in its profile, the spec's covered components and `Content-Digest` are enforced, and a request that carries a DPoP proof or credential is never accepted on a signature instead. Advertised as `http_message_signature` in the profile's `authorization` policy. Not offered over MCP.

  New error codes: `proof_nonce_required`, `signature_missing`, `signature_invalid`, `signature_expired`, `key_not_found`, `digest_mismatch`, `algorithm_unsupported`. The choices the spec leaves open are in `docs/SPEC-NOTES.md` section 6.

- db42a3d: Add `usp` to `createOpenBookingApp`: mounts USP (`/usp`, `/.well-known/usp`) for assistants and platforms that book through the Universal Scheduling Protocol. Off unless set; by default the customer confirms on the booking page (`consent: 'action'`). Calls from USP platforms are credited to their own channel in Studio.
- 074f42f: Waitlist tools. Pass a core `Waitlist` as `waitlist` to `createMcpServer`, `createMcpHttpHandler` or `createOpenBookingApp` to add `join_waitlist`, `check_waitlist` and `leave_waitlist` (and a short paragraph in the server instructions). Without one nothing changes. Every response carries a `next_step`; an offered entry shows the held booking and tells the agent to confirm it only after the user approves.

### Patch Changes

- e6a751c: Add the `booking.expired` webhook event, and an `expire` engine event, for holds that lapse without being confirmed or cancelled. Nothing runs when a hold expires, so the event is sent when a read first notices it or when `service.sweepExpired()` runs (call it from a cron or timer to report lapses nobody reads). Each expiry is announced at most once across instances through a new `expiryClaims` option (hosted reuses its email dedupe log; pass `PostgresNotificationLog` when running several instances on one database). The event carries no actor, and Studio shows it as a system entry.
- 53b27b1: Studio without a token is now open only for local development. Before, a localhost `baseUrl` alone opened it, which is also what a deployed app has when `BASE_URL` was never set. Now Studio stays locked when `NODE_ENV` is `production` or a hosting platform's environment variable is set (a line at start says why), and each request must come from the machine the server runs on: not from another address, not through a proxy or tunnel, and not under another host name. `listen()` passes the connection to the app so this can be checked. If you use Studio without a token from another device, in Docker or through a tunnel, set a Studio token.
- 787f01c: USP: platform profiles are now fetched (safely, public internet only) and capabilities negotiated. `usp.platformProfiles` on `createOpenBookingApp` and `uspPlatformProfiles` on `createHostedApp` take a fetcher or `false`; hosted shares one fetcher, and so one cache, across all businesses.
- Updated dependencies [6ae5bb8]
- Updated dependencies [45b5786]
- Updated dependencies [de2a7ef]
- Updated dependencies [3d98490]
- Updated dependencies [e6a751c]
- Updated dependencies [7f71337]
- Updated dependencies [5b1fb9a]
- Updated dependencies [8e2e69d]
- Updated dependencies [3825c49]
- Updated dependencies [086199e]
- Updated dependencies [dd8e9ca]
- Updated dependencies [02b8605]
- Updated dependencies [c8d546c]
- Updated dependencies [bb06329]
- Updated dependencies [aaba0ca]
- Updated dependencies [92f6c50]
- Updated dependencies [5dc9991]
- Updated dependencies [db42a3d]
- Updated dependencies [db42a3d]
- Updated dependencies [89789c9]
- Updated dependencies [b598d10]
- Updated dependencies [787f01c]
- Updated dependencies [db42a3d]
- Updated dependencies [cdbb3c4]
- Updated dependencies [074f42f]
- Updated dependencies [074f42f]
  - @openbooking-sh/core@0.13.0
  - @openbooking-sh/booking-page@0.13.0
  - @openbooking-sh/studio@0.13.0
  - @openbooking-sh/adapter-mcp@0.13.0
  - @openbooking-sh/adapter-usp@0.13.0
  - @openbooking-sh/adapter-a2a@0.13.0
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
