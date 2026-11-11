# @openbooking-sh/postgres

## 0.13.0

### Minor Changes

- de2a7ef: Anti-scalping, all optional (`serviceOptions.guard`; without it nothing changes). Limits per guest (upcoming bookings per venue and per day, by normalised email or phone) and per agent (open holds and active bookings, by client name or a `identifyAgent` hook for a verified id), checked atomically with a ledger write so concurrent holds cannot slip past. Name-bound bookings: with `nonTransferable`, only the venue can put another name on a booking, and the terms say so. Broker-pattern flags (many names from one agent or contact, repeated book-then-cancel) mark a booking for staff without refusing it; they are returned by `service.riskFlags()` and Studio's `/api/bookings`, never in agent or public responses. Two new error codes, `booking_limit_reached` and `not_transferable`. Postgres: `PostgresGuardStore` and migration 8 (`ob_guard`, hashed keys only). Verified agent identity (Web Bot Auth) is separate (OPE-57).
- 086199e: Guest profiles, allergy notes and a pre-shift summary, all staff-only.

  - **Allergy and dietary notes.** `hold_slot` (MCP), the booking page's confirm request and `service.hold` / `service.update` take an optional `dietary_notes` (300 characters). It is stored apart from the booking (a new `GuestStore`, `ob_dietary_notes` in Postgres), so no protocol response, email, webhook event, activity entry, analytics event or idempotency record can carry it. Studio shows it on the booking and in the pre-shift summary. It is deleted a day after the visit (`dietaryNoteRetentionDays`, hosted `dietaryNoteRetentionDays`; the daily purge does it), when the booking is cancelled or lapses, with the customer's erasure, and with the account. MCP agents are told it is optional and to use only what the guest said; `notes` no longer suggests allergies.
  - **Guest profiles.** Staff set tags, notes and a VIP flag per guest in Studio (booking drawer, Customers). A guest is a per-business hash of their email (or phone), so nothing links guests across businesses and the profile table holds no contact detail. Visit count and last visit come from the business's own bookings. Profiles are in the customer export, removed on erasure and when no booking with that guest's details is left.
  - **Pre-shift summary.** `GET /studio/api/preshift?date=` and a Pre-shift view: covers, party sizes, VIPs, first-time versus returning guests, allergy notes.
  - **Postgres.** Migration 8 adds `ob_dietary_notes` and `ob_guest_profiles` (row level security on). `postgresStores(db).guests` is the store; pass it as `guests` to `createHostedApp` and `serviceOptions`.

- dd8e9ca: API keys for hosted businesses, so a site with no backend can call its own booking API. Owners make keys in Studio → Settings → API keys (a name, and `read` or `book`); the secret is shown once and only a hash is stored. Send it as `x-openbooking-key` or `Authorization: Bearer obk_…` to `/b/{id}/book/api/*` or `/b/{id}/mcp`. Each key works for one business, is rate-limited on its own (300 a minute), shows when it was last used and can be revoked. Calls without a key stay public as before: a key identifies and limits a caller, it does not lock the API. New `apiKeys` option on `createHostedApp` (memory by default), `PostgresApiKeyStore` and `postgresStores(db).apiKeys` with migration 6 (`ob_api_keys`), and `api_keys` on Studio's `SettingsView`. The booking page's CORS preflight now allows the `x-openbooking-key` header.
- 02b8605: Join tables for larger parties. `table_combinations` on a venue lists tables that may be pushed together (for example t6 + t7 seats 5 to 8, with an optional extra turnover and label). A party gets the smallest single table that fits as before; joined tables are offered only when no single table is free, choosing the pair that wastes the fewest seats. One booking occupies all its tables, claimed all-or-nothing in the memory and Postgres stores, and cancel, expiry and reschedule free or move all of them. Slots keep `resource` as the first table and add `additional_resources`; the label reads "Tables T6 and T7 together" and the MCP `next_step` tells the agent to say so. Studio shows a joined booking on each table's column. Postgres adds migration 7 (`extra_resource_ids`). Existing configs and stored bookings are unchanged.
- 5dc9991: The same idempotency key sent to two server instances at the same instant now runs once. Before, both instances ran, so one customer could end up with two holds (on two staff members; no slot was ever given out twice). `IdempotencyStore` gets an optional `claim()` and `release()`: the first instance to claim the key runs, the other waits for its result and replays it, and a claim whose instance died expires after 60 seconds. `PostgresIdempotencyStore` implements them with one `insert … on conflict` statement (no migration), and hosted passes them through its per-business key prefix. A custom store without `claim()` keeps the old per-process behaviour.
- 627d7f7: Restaurant timing. An offering can set `duration_by_party` (for example 2 guests 90 minutes, 6 guests 2.5 hours); `duration_minutes` stays the default, so existing configs are unchanged. A venue can set `service_periods` (lunch and dinner, optional fixed `seatings`, a `max_online_guests` walk-in reserve) and `pacing` (a cap on guests starting in the same 15 minutes). Limits count held and confirmed bookings, never offer a start that a hold would refuse, and are enforced atomically with the reservation, also in the Postgres store. Custom stores receive the limits as `caps` on the record they insert.
- edba76d: Customers can unsubscribe from a business's emails. Customer emails carry an unsubscribe link and the RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers (`EmailMessage.headers`, passed on by `ResendMailer`). Hosted serves `/unsubscribe`: a GET shows a button, the POST records a hash of the address for that business, and nothing more is sent to it. New `SuppressionList` (`MemorySuppressionList`, `PostgresSuppressionList`, migration 5), `isSuppressed` and `unsubscribeUrl` options in `attachNotifications`, and a `suppressions` option on `createHostedApp` (`stores.suppressions` with Postgres).
- 65bea74: Add `PostgresUspState` (also `postgresStores(db).usp`): durable state for the USP adapter, so owners, booking credentials (by hash), replay memory and request keys are shared by every server instance. Migration 4 adds five `ob_usp_*` tables, with row level security like the rest; `migrate(db)` applies it. No customer details are stored in them.
- 074f42f: Waitlist store. `PostgresWaitlistStore` (also `postgresStores(db).waitlist`) keeps waitlist entries shared by every instance; claiming an entry locks its row, so two instances cannot offer the same entry twice. Migration 8 adds the `ob_waitlist` table (row level security on); `migrate(db)` applies it.

### Patch Changes

- a5cd2c1: `migrate()` recognises an up-to-date database with a single query instead of a transaction, an advisory lock and three more statements, which trims serverless cold starts by four database round trips. Databases with pending migrations (including fresh ones) still take the lock, so instances booting at the same time stay serialised.
- Updated dependencies [6ae5bb8]
- Updated dependencies [45b5786]
- Updated dependencies [de2a7ef]
- Updated dependencies [e6a751c]
- Updated dependencies [7f71337]
- Updated dependencies [8e2e69d]
- Updated dependencies [3f34dc9]
- Updated dependencies [3825c49]
- Updated dependencies [8e2e69d]
- Updated dependencies [086199e]
- Updated dependencies [dd8e9ca]
- Updated dependencies [02b8605]
- Updated dependencies [bb06329]
- Updated dependencies [aaba0ca]
- Updated dependencies [92f6c50]
- Updated dependencies [4e52868]
- Updated dependencies [5dc9991]
- Updated dependencies [3faa27f]
- Updated dependencies [627d7f7]
- Updated dependencies [edba76d]
- Updated dependencies [db42a3d]
- Updated dependencies [db42a3d]
- Updated dependencies [89789c9]
- Updated dependencies [787f01c]
- Updated dependencies [db42a3d]
- Updated dependencies [cdbb3c4]
- Updated dependencies [074f42f]
- Updated dependencies [074f42f]
  - @openbooking-sh/hosted@0.13.0
  - @openbooking-sh/core@0.13.0
  - @openbooking-sh/studio@0.13.0
  - @openbooking-sh/provider-memory@0.13.0
  - @openbooking-sh/notifications@0.13.0
  - @openbooking-sh/google-calendar@0.13.0
  - @openbooking-sh/provider-calcom@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0
  - @openbooking-sh/hosted@0.12.0
  - @openbooking-sh/studio@0.12.0
  - @openbooking-sh/google-calendar@0.12.0
  - @openbooking-sh/notifications@0.12.0
  - @openbooking-sh/provider-calcom@0.12.0
  - @openbooking-sh/provider-memory@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [10e30b3]
  - @openbooking-sh/hosted@0.11.0
  - @openbooking-sh/studio@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [7fdf84e]
- Updated dependencies [12ec3a2]
  - @openbooking-sh/hosted@0.10.0
  - @openbooking-sh/studio@0.10.0
  - @openbooking-sh/core@0.10.0
  - @openbooking-sh/provider-memory@0.10.0
  - @openbooking-sh/google-calendar@0.10.0
  - @openbooking-sh/notifications@0.10.0
  - @openbooking-sh/provider-calcom@0.10.0

## 0.9.0

### Minor Changes

- dd48af2: Hosted owners can download everything stored about their business and close their account
  (GDPR articles 15 and 17), from the compliance audit.

  - Studio, Settings, "Your account": download a JSON file (account, settings, every booking; never the
    password hash or Google tokens) and delete the account with the password. Deleting removes calendar
    links, activity and attribution, idempotency records, all bookings and finally the account, in that
    order, so a failed attempt can be retried.
  - New optional store methods: `BookingRecordStore.deleteVenue`, `BusinessStore.delete`,
    `IdempotencyStore.deletePrefix`, `ActivityLog.clear`, `RateLimiter.purge`. Memory and Postgres
    implement them; closing an account refuses with 501 when the stores cannot delete.
  - The daily purge also clears expired rate-limit windows, which are keyed by IP address.

- dfb5e56: Customer data rights (GDPR articles 15 and 17) and retention, from the compliance audit.

  - `BookingRecordStore` gets an optional `anonymize(query, now)`: it removes the customer's name,
    contact details and notes from bookings and keeps the booking itself. Implemented for the memory
    and Postgres stores. Upcoming bookings (held or confirmed, not yet ended) are kept and counted, and
    a query must name a customer or an age, so it can never erase everything.
  - Studio gets `dataRights` (an adapter) and, when set, `POST /api/customers/export` and
    `POST /api/customers/erase`, plus a "Customer data" card in Settings. POST so an email address
    or phone number stays out of URLs and logs.
  - Hosted wires it up, and removes customer data from bookings that ended more than `retentionDays`
    ago (default 730) through `GET /api/maintenance/purge`, which needs `cronSecret` (`CRON_SECRET`).
    `vercel.json` runs it daily.

### Patch Changes

- c766b13: Privacy basics from the compliance audit:

  - No more Google Fonts: the booking page, Studio, sign-up and setup no longer load anything from
    Google, so a visit does not hand the visitor's IP address to a third party. The font stack falls
    back to the system font (Geist still applies if installed).
  - The PostHog snippet on owner pages counts page views only: autocapture and heatmaps are off and
    all text is masked, because Studio shows customer names and notes. The password reset page no
    longer carries the snippet, since its link holds the reset token.
  - Migration 3 turns on row level security for every `ob_` table. With no policies, a role that does
    not own the tables (a REST or Data API layer's anon role) sees nothing. The role OpenBooking
    connects as must be the one that created the tables, as it is by default.

- Updated dependencies [dd48af2]
- Updated dependencies [c766b13]
- Updated dependencies [dfb5e56]
- Updated dependencies [e2d4873]
- Updated dependencies [eb99a97]
  - @openbooking-sh/core@0.9.0
  - @openbooking-sh/provider-memory@0.9.0
  - @openbooking-sh/studio@0.9.0
  - @openbooking-sh/hosted@0.9.0
  - @openbooking-sh/notifications@0.9.0
  - @openbooking-sh/google-calendar@0.9.0
  - @openbooking-sh/provider-calcom@0.9.0

## 0.7.0

### Minor Changes

- 7c9ad2d: Rescheduling. `service.reschedule()` and the `reschedule_booking` MCP tool move a confirmed booking to another time for the same service and party size, keeping its id and confirmation code. Allowed while cancellation is still free (`reschedule_not_allowed` after that), with explicit consent. Providers implement the optional `rescheduleBooking`; `BookingRecordStore.move` does it atomically in the memory and Postgres stores (both resources locked in a fixed order).

### Patch Changes

- Updated dependencies [7c9ad2d]
- Updated dependencies [e4b56d6]
- Updated dependencies [783a56e]
  - @openbooking-sh/core@0.7.0
  - @openbooking-sh/provider-memory@0.7.0
  - @openbooking-sh/hosted@0.7.0
  - @openbooking-sh/google-calendar@0.7.0
  - @openbooking-sh/notifications@0.7.0
  - @openbooking-sh/provider-calcom@0.7.0
  - @openbooking-sh/studio@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [899afde]
  - @openbooking-sh/hosted@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [b375ced]
  - @openbooking-sh/hosted@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [6e7ca09]
  - @openbooking-sh/hosted@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [17bf1ca]
  - @openbooking-sh/hosted@0.3.0

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
  - @openbooking-sh/provider-memory@0.2.0
  - @openbooking-sh/studio@0.2.0
  - @openbooking-sh/hosted@0.2.0
  - @openbooking-sh/google-calendar@0.2.0
  - @openbooking-sh/notifications@0.2.0
  - @openbooking-sh/provider-calcom@0.2.0

## 0.1.1

### Patch Changes

- 77a3ffa: Fix: loading `@openbooking-sh/postgres` no longer requires `@openbooking-sh/hosted`. Apps that use Postgres without hosted crashed at startup with `ERR_MODULE_NOT_FOUND`.
- Updated dependencies [77a3ffa]
  - @openbooking-sh/hosted@0.1.1
  - @openbooking-sh/studio@0.1.1
