# @openbooking-sh/studio

## 0.13.0

### Minor Changes

- de2a7ef: Anti-scalping, all optional (`serviceOptions.guard`; without it nothing changes). Limits per guest (upcoming bookings per venue and per day, by normalised email or phone) and per agent (open holds and active bookings, by client name or a `identifyAgent` hook for a verified id), checked atomically with a ledger write so concurrent holds cannot slip past. Name-bound bookings: with `nonTransferable`, only the venue can put another name on a booking, and the terms say so. Broker-pattern flags (many names from one agent or contact, repeated book-then-cancel) mark a booking for staff without refusing it; they are returned by `service.riskFlags()` and Studio's `/api/bookings`, never in agent or public responses. Two new error codes, `booking_limit_reached` and `not_transferable`. Postgres: `PostgresGuardStore` and migration 8 (`ob_guard`, hashed keys only). Verified agent identity (Web Bot Auth) is separate (OPE-57).
- e6a751c: Add the `booking.expired` webhook event, and an `expire` engine event, for holds that lapse without being confirmed or cancelled. Nothing runs when a hold expires, so the event is sent when a read first notices it or when `service.sweepExpired()` runs (call it from a cron or timer to report lapses nobody reads). Each expiry is announced at most once across instances through a new `expiryClaims` option (hosted reuses its email dedupe log; pass `PostgresNotificationLog` when running several instances on one database). The event carries no actor, and Studio shows it as a system entry.
- 7f71337: Booking source. Every new booking records where it came from: `source: { channel, agent? }`, with the channel one of `mcp`, `ucp`, `a2a`, `usp`, `website`, `embed`, `phone`, `walk_in` or `other`, and the assistant's own name for itself when the protocol gives one (MCP client name, UCP/USP platform host, browser family). It is set when the hold is made and kept through confirm, reschedule and cancel. The assistant name is self-reported and not verified. Bookings made before this have no source and show as "Unknown". It never changes a price, deposit or cancellation term.

  Studio shows the source in the booking list and drawer, can filter by it, counts bookings per source for a date range (Insights), exports bookings as CSV (no contact details), and the new-booking form asks staff whether it came by phone or walk-in. Hosted analytics carry only the channel and a coarse assistant group (ChatGPT, Gemini, ...), never customer data. The embed script sends `x-openbooking-source: embed`; a provider that stores bookings should keep `source` from `CreateHoldRequest`.

- 8e2e69d: Consent evidence in the agent log. A confirm, move or cancellation that went through on `user_confirmed: true` now emits a `consent` field on its `BookingEvent` (`ConsentEvidence`): the service, time, party size, price, deposit and cancellation terms the booking carried at that moment, and for a cancellation the fee and refund. Studio keeps it on the activity entry (`ActivityEntry.consent`, no database change: entries are JSON) and shows it under the action in the Agent log and in a booking's history. It holds no customer name, email or phone. Replays and releasing a hold carry none.
- 086199e: Guest profiles, allergy notes and a pre-shift summary, all staff-only.

  - **Allergy and dietary notes.** `hold_slot` (MCP), the booking page's confirm request and `service.hold` / `service.update` take an optional `dietary_notes` (300 characters). It is stored apart from the booking (a new `GuestStore`, `ob_dietary_notes` in Postgres), so no protocol response, email, webhook event, activity entry, analytics event or idempotency record can carry it. Studio shows it on the booking and in the pre-shift summary. It is deleted a day after the visit (`dietaryNoteRetentionDays`, hosted `dietaryNoteRetentionDays`; the daily purge does it), when the booking is cancelled or lapses, with the customer's erasure, and with the account. MCP agents are told it is optional and to use only what the guest said; `notes` no longer suggests allergies.
  - **Guest profiles.** Staff set tags, notes and a VIP flag per guest in Studio (booking drawer, Customers). A guest is a per-business hash of their email (or phone), so nothing links guests across businesses and the profile table holds no contact detail. Visit count and last visit come from the business's own bookings. Profiles are in the customer export, removed on erasure and when no booking with that guest's details is left.
  - **Pre-shift summary.** `GET /studio/api/preshift?date=` and a Pre-shift view: covers, party sizes, VIPs, first-time versus returning guests, allergy notes.
  - **Postgres.** Migration 8 adds `ob_dietary_notes` and `ob_guest_profiles` (row level security on). `postgresStores(db).guests` is the store; pass it as `guests` to `createHostedApp` and `serviceOptions`.

- dd8e9ca: API keys for hosted businesses, so a site with no backend can call its own booking API. Owners make keys in Studio → Settings → API keys (a name, and `read` or `book`); the secret is shown once and only a hash is stored. Send it as `x-openbooking-key` or `Authorization: Bearer obk_…` to `/b/{id}/book/api/*` or `/b/{id}/mcp`. Each key works for one business, is rate-limited on its own (300 a minute), shows when it was last used and can be revoked. Calls without a key stay public as before: a key identifies and limits a caller, it does not lock the API. New `apiKeys` option on `createHostedApp` (memory by default), `PostgresApiKeyStore` and `postgresStores(db).apiKeys` with migration 6 (`ob_api_keys`), and `api_keys` on Studio's `SettingsView`. The booking page's CORS preflight now allows the `x-openbooking-key` header.
- 02b8605: Join tables for larger parties. `table_combinations` on a venue lists tables that may be pushed together (for example t6 + t7 seats 5 to 8, with an optional extra turnover and label). A party gets the smallest single table that fits as before; joined tables are offered only when no single table is free, choosing the pair that wastes the fewest seats. One booking occupies all its tables, claimed all-or-nothing in the memory and Postgres stores, and cancel, expiry and reschedule free or move all of them. Slots keep `resource` as the first table and add `additional_resources`; the label reads "Tables T6 and T7 together" and the MCP `next_step` tells the agent to say so. Studio shows a joined booking on each table's column. Postgres adds migration 7 (`extra_resource_ids`). Existing configs and stored bookings are unchanged.
- 92f6c50: Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.
- db42a3d: Add the "Let assistants and platforms book me directly (USP)" setting (`assistants.usp`: off, confirm, instant), and show bookings made through USP as their own channel with the calling platform's name.

### Patch Changes

- aaba0ca: A refund now checks what Stripe has already refunded on the payment and sends only the difference, so a partial refund retried after Stripe's 24 hour idempotency window no longer pays the customer twice (and refunds made by hand in the Stripe dashboard count). If the refunds already made cannot be read, nothing is refunded and the call fails instead of guessing; the Stripe key must be able to read Refunds. Studio's booking drawer gains a Payment line: waiting, not paid, paid online or in person, and the refund and amount kept after a cancellation.
- Updated dependencies [6ae5bb8]
- Updated dependencies [de2a7ef]
- Updated dependencies [e6a751c]
- Updated dependencies [7f71337]
- Updated dependencies [8e2e69d]
- Updated dependencies [3825c49]
- Updated dependencies [086199e]
- Updated dependencies [02b8605]
- Updated dependencies [5dc9991]
- Updated dependencies [db42a3d]
- Updated dependencies [cdbb3c4]
- Updated dependencies [074f42f]
  - @openbooking-sh/core@0.13.0

## 0.12.0

### Patch Changes

- e3fac6c: Stripe webhooks for hosted deposits. Connecting a Stripe key now also registers a webhook endpoint
  (when the key may write Webhook Endpoints). When a customer pays and never returns to the booking
  page, the webhook refunds the payment once the hold has expired; while the hold is live it asks
  Stripe to deliver again later. New `BookingService.reconcilePayment`, and `StripePayments`
  `createWebhook` / `deleteWebhook` plus `verifyWebhook` for checking Stripe's signature.
- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0

## 0.11.0

### Minor Changes

- 10e30b3: Hosted businesses can take deposits through their own Stripe account. Studio has an Online
  payments card (connect a key, set a deposit percentage); the booking page sends the customer to
  Stripe Checkout and confirms the booking when they return. The booking page API now passes
  `payment_token` through to the engine.

## 0.10.0

### Patch Changes

- 7fdf84e: Logging out of Studio now ends every session of the account on the server, so a copied token stops
  working at once (it used to live on until it expired). Session tokens now last 7 days instead of 30.
- Updated dependencies [12ec3a2]
  - @openbooking-sh/core@0.10.0

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

- e2d4873: Accessibility basics (WCAG 2.1 AA) from the compliance audit:

  - Muted text is darker in light mode (`#646b80`, 4.6:1 or better on every background; it was `#8a90a3`, about 3:1) on the booking page, Studio, sign-up, setup, reset and the booking emails.
  - Errors and status messages are announced (`role="alert"` and a polite live region), so a screen reader user hears "no free times" or a failed sign-up.
  - Service, staff, date and time buttons say whether they are selected (`aria-pressed`).
  - Studio's new-booking form ties each label to its field, and the login fields have names.
  - The embed popup moves focus into the dialog, keeps it there while open, and returns it to the button that opened it. The decorative logo is hidden from screen readers.

- Updated dependencies [dd48af2]
- Updated dependencies [eb99a97]
  - @openbooking-sh/core@0.9.0

## 0.7.0

### Patch Changes

- Updated dependencies [7c9ad2d]
- Updated dependencies [e4b56d6]
- Updated dependencies [783a56e]
  - @openbooking-sh/core@0.7.0

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

## 0.1.1

### Patch Changes

- 77a3ffa: Business, service and staff ids from names with å, æ, ø or accents are now clean: "Bjørn & Åse Frisør" becomes `bjorn-ase-frisor` (was `bjorn-a-se-frisor`). Existing ids don't change.
