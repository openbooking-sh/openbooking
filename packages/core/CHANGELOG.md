# @openbooking-sh/core

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

- 02b8605: Join tables for larger parties. `table_combinations` on a venue lists tables that may be pushed together (for example t6 + t7 seats 5 to 8, with an optional extra turnover and label). A party gets the smallest single table that fits as before; joined tables are offered only when no single table is free, choosing the pair that wastes the fewest seats. One booking occupies all its tables, claimed all-or-nothing in the memory and Postgres stores, and cancel, expiry and reschedule free or move all of them. Slots keep `resource` as the first table and add `additional_resources`; the label reads "Tables T6 and T7 together" and the MCP `next_step` tells the agent to say so. Studio shows a joined booking on each table's column. Postgres adds migration 7 (`extra_resource_ids`). Existing configs and stored bookings are unchanged.
- 5dc9991: The same idempotency key sent to two server instances at the same instant now runs once. Before, both instances ran, so one customer could end up with two holds (on two staff members; no slot was ever given out twice). `IdempotencyStore` gets an optional `claim()` and `release()`: the first instance to claim the key runs, the other waits for its result and replays it, and a claim whose instance died expires after 60 seconds. `PostgresIdempotencyStore` implements them with one `insert … on conflict` statement (no migration), and hosted passes them through its per-business key prefix. A custom store without `claim()` keeps the old per-process behaviour.
- cdbb3c4: Venue knowledge for assistants. A venue can carry an optional `knowledge` block: cuisine, a short about text, a menu (link and a few dishes with prices in minor units), dietary options, atmosphere, accessibility features, parking, dress code, languages and a children policy. `get_business_info` (MCP and A2A) returns it, the booking page's `/info` returns it when present, the schema.org data adds `servesCuisine`, `hasMenu` and `amenityFeature`, and the USP catalog passes it through each service's `metadata` under `sh.openbooking.venue_knowledge` (USP has no dedicated field). The facts always travel with a `safety_note` telling the assistant that dietary options are offers, not allergen guarantees, and that guests must confirm allergies with the venue; the model has no allergen-free field. The demo restaurant now has knowledge. Existing venues, configs and stored hosted settings are unchanged.
- 074f42f: Waitlist (OPE-20). `new Waitlist({ service })` lets a customer join for a full day and be offered a freed slot: when a booking is cancelled or a hold lapses, the first matching entry gets a real hold for a short window (`offerTtlSeconds`, default 15 minutes) and a `WaitlistEvent` of type `offered`, so the customer can be told. Accepting is the normal `confirm` with `user_confirmed`. Joining is refused while something is bookable, needs `user_confirmed` and is idempotent. Entries are claimed atomically in a `WaitlistStore` (`MemoryWaitlistStore` included), so a slot is offered once and an entry holds one slot; `sweep()` retires stale entries and deletes finished ones after `retentionDays`; `exportCustomer` and `eraseCustomer` cover customer data requests. `BookingService.hold` takes an optional `{ ttlSeconds }`.

### Patch Changes

- 6ae5bb8: Abuse limits for hosted. Request bodies over 256 KB get a 413 (`maxBodyBytes` to change it). Holds are now counted in the shared rate limiter (Postgres in production), per business and IP, so the limit holds across instances and cold starts instead of resetting in each process. Sign-ups also have a cap of 100 an hour across all addresses, counted after the per-IP check. In core, customer names (100), email (254), ids (200) and payment tokens (500) in booking requests have length caps.
- 3825c49: Two fixes found by the new concurrency and daylight-saving fuzz tests. On the night clocks jump forward, a venue open through the missing hour was offered duplicate slots (02:00 and 02:30 collapsed onto 03:00 and 03:30); times that do not exist are now skipped. And releasing a hold (which needs no consent) while the customer confirms it could cancel the booking they had just confirmed; the release now loses that race (`release_hold` on `CancelBookingRequest`, honoured by the memory and Postgres stores).
- db42a3d: Add `usp` to the actor protocols, so bookings made through the Universal Scheduling Protocol are credited to their own channel.

## 0.12.0

### Minor Changes

- e3fac6c: Stripe webhooks for hosted deposits. Connecting a Stripe key now also registers a webhook endpoint
  (when the key may write Webhook Endpoints). When a customer pays and never returns to the booking
  page, the webhook refunds the payment once the hold has expired; while the hold is live it asks
  Stripe to deliver again later. New `BookingService.reconcilePayment`, and `StripePayments`
  `createWebhook` / `deleteWebhook` plus `verifyWebhook` for checking Stripe's signature.

## 0.10.0

### Minor Changes

- 12ec3a2: Deposits can now be taken for real. `BookingService` accepts a `payments` provider; the new
  `@openbooking-sh/payments-stripe` is one, using Stripe Checkout. When a deposit is due,
  `confirm_booking` replies `payment_required` with a payment link; once the customer has paid, the
  engine verifies with Stripe that this booking's deposit was paid before it confirms, so an agent
  cannot skip the payment with a made-up token. Cancelling refunds by the cancellation terms
  (`refund_failed` if Stripe is down, and a retry never refunds twice), and a payment that arrives
  after the hold expired is refunded. Studio's "deposit collected" still works.

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

### Patch Changes

- eb99a97: Webhook events now reach each endpoint in the order they happened. Deliveries used to run
  concurrently, so a cancellation could arrive before the confirmation it cancelled. An endpoint that
  keeps failing holds back its later events until the earlier one succeeds or gives up.

## 0.7.0

### Minor Changes

- 7c9ad2d: Rescheduling. `service.reschedule()` and the `reschedule_booking` MCP tool move a confirmed booking to another time for the same service and party size, keeping its id and confirmation code. Allowed while cancellation is still free (`reschedule_not_allowed` after that), with explicit consent. Providers implement the optional `rescheduleBooking`; `BookingRecordStore.move` does it atomically in the memory and Postgres stores (both resources locked in a fixed order).
- e4b56d6: Staff working hours and time off. `VenueConfig.schedules` gives any resource weekly hours (within opening hours) and time off (whole days or exact times, venue-local, DST-safe); availability and holds respect both. `VenueInfo.staff_hours` and the MCP `get_business_info` tool tell agents who works when; time off stays private.
- 783a56e: Webhooks: `createWebhooks()` (core) and the `webhooks` option of `createOpenBookingApp` send signed `booking.held`, `.confirmed`, `.updated` and `.cancelled` events with retries; `verifyWebhook()` checks them on the receiving side. Replays and no-op cancels don't send events (`BookingEvent.unchanged` marks the latter).

## 0.2.0

### Minor Changes

- 4d9f0fc: Better for agents and safer in public, from a fresh-eyes test of the SDK:

  - New MCP tool `get_business_info`: services, staff, opening hours and booking window.
  - Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
  - `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
  - New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
  - Providers can expose opening hours with `getVenueInfo`.
