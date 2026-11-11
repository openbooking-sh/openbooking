# create-openbooking

## 0.2.2

### Patch Changes

- 086199e: Guest profiles, allergy notes and a pre-shift summary, all staff-only.

  - **Allergy and dietary notes.** `hold_slot` (MCP), the booking page's confirm request and `service.hold` / `service.update` take an optional `dietary_notes` (300 characters). It is stored apart from the booking (a new `GuestStore`, `ob_dietary_notes` in Postgres), so no protocol response, email, webhook event, activity entry, analytics event or idempotency record can carry it. Studio shows it on the booking and in the pre-shift summary. It is deleted a day after the visit (`dietaryNoteRetentionDays`, hosted `dietaryNoteRetentionDays`; the daily purge does it), when the booking is cancelled or lapses, with the customer's erasure, and with the account. MCP agents are told it is optional and to use only what the guest said; `notes` no longer suggests allergies.
  - **Guest profiles.** Staff set tags, notes and a VIP flag per guest in Studio (booking drawer, Customers). A guest is a per-business hash of their email (or phone), so nothing links guests across businesses and the profile table holds no contact detail. Visit count and last visit come from the business's own bookings. Profiles are in the customer export, removed on erasure and when no booking with that guest's details is left.
  - **Pre-shift summary.** `GET /studio/api/preshift?date=` and a Pre-shift view: covers, party sizes, VIPs, first-time versus returning guests, allergy notes.
  - **Postgres.** Migration 8 adds `ob_dietary_notes` and `ob_guest_profiles` (row level security on). `postgresStores(db).guests` is the store; pass it as `guests` to `createHostedApp` and `serviceOptions`.

- 53b27b1: Studio without a token is now open only for local development. Before, a localhost `baseUrl` alone opened it, which is also what a deployed app has when `BASE_URL` was never set. Now Studio stays locked when `NODE_ENV` is `production` or a hosting platform's environment variable is set (a line at start says why), and each request must come from the machine the server runs on: not from another address, not through a proxy or tunnel, and not under another host name. `listen()` passes the connection to the app so this can be checked. If you use Studio without a token from another device, in Docker or through a tunnel, set a Studio token.

## 0.2.1

### Patch Changes

- 98658a9: New projects depend on each package's own version. 0.2.0 asked for `@openbooking-sh/postgres@^0.2.0`, which doesn't exist (postgres went from 0.1.1 to 0.3.0), so `npm install` failed.

## 0.2.0

### Minor Changes

- 4d9f0fc: Better for agents and safer in public, from a fresh-eyes test of the SDK:

  - New MCP tool `get_business_info`: services, staff, opening hours and booking window.
  - Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
  - `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
  - New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
  - Providers can expose opening hours with `getVenueInfo`.
