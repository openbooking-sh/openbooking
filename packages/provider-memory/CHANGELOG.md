# @openbooking-sh/provider-memory

## 0.13.0

### Minor Changes

- 7f71337: Booking source. Every new booking records where it came from: `source: { channel, agent? }`, with the channel one of `mcp`, `ucp`, `a2a`, `usp`, `website`, `embed`, `phone`, `walk_in` or `other`, and the assistant's own name for itself when the protocol gives one (MCP client name, UCP/USP platform host, browser family). It is set when the hold is made and kept through confirm, reschedule and cancel. The assistant name is self-reported and not verified. Bookings made before this have no source and show as "Unknown". It never changes a price, deposit or cancellation term.

  Studio shows the source in the booking list and drawer, can filter by it, counts bookings per source for a date range (Insights), exports bookings as CSV (no contact details), and the new-booking form asks staff whether it came by phone or walk-in. Hosted analytics carry only the channel and a coarse assistant group (ChatGPT, Gemini, ...), never customer data. The embed script sends `x-openbooking-source: embed`; a provider that stores bookings should keep `source` from `CreateHoldRequest`.

- 02b8605: Join tables for larger parties. `table_combinations` on a venue lists tables that may be pushed together (for example t6 + t7 seats 5 to 8, with an optional extra turnover and label). A party gets the smallest single table that fits as before; joined tables are offered only when no single table is free, choosing the pair that wastes the fewest seats. One booking occupies all its tables, claimed all-or-nothing in the memory and Postgres stores, and cancel, expiry and reschedule free or move all of them. Slots keep `resource` as the first table and add `additional_resources`; the label reads "Tables T6 and T7 together" and the MCP `next_step` tells the agent to say so. Studio shows a joined booking on each table's column. Postgres adds migration 7 (`extra_resource_ids`). Existing configs and stored bookings are unchanged.
- 627d7f7: Restaurant timing. An offering can set `duration_by_party` (for example 2 guests 90 minutes, 6 guests 2.5 hours); `duration_minutes` stays the default, so existing configs are unchanged. A venue can set `service_periods` (lunch and dinner, optional fixed `seatings`, a `max_online_guests` walk-in reserve) and `pacing` (a cap on guests starting in the same 15 minutes). Limits count held and confirmed bookings, never offer a start that a hold would refuse, and are enforced atomically with the reservation, also in the Postgres store. Custom stores receive the limits as `caps` on the record they insert.
- cdbb3c4: Venue knowledge for assistants. A venue can carry an optional `knowledge` block: cuisine, a short about text, a menu (link and a few dishes with prices in minor units), dietary options, atmosphere, accessibility features, parking, dress code, languages and a children policy. `get_business_info` (MCP and A2A) returns it, the booking page's `/info` returns it when present, the schema.org data adds `servesCuisine`, `hasMenu` and `amenityFeature`, and the USP catalog passes it through each service's `metadata` under `sh.openbooking.venue_knowledge` (USP has no dedicated field). The facts always travel with a `safety_note` telling the assistant that dietary options are offers, not allergen guarantees, and that guests must confirm allergies with the venue; the model has no allergen-free field. The demo restaurant now has knowledge. Existing venues, configs and stored hosted settings are unchanged.

### Patch Changes

- 3f34dc9: `MemoryBookingProvider` no longer records a deposit as paid from a `payment_token` that nobody checked. Before, with no payment provider configured, any token starting with `tok_` (and `manual:…` from any caller) confirmed a booking with the deposit marked paid. Now such a confirm fails with `operation_not_supported`, the hold stays a hold, and a warning is logged once. The pretend `tok_…` tokens need the new `demoPayments: true` option (the demo salon and restaurant factories switch it on), and `manual:…` is accepted only from Studio. If you sell a service with a deposit, set `serviceOptions.payments` (for example `@openbooking-sh/payments-stripe`).
- 3825c49: Two fixes found by the new concurrency and daylight-saving fuzz tests. On the night clocks jump forward, a venue open through the missing hour was offered duplicate slots (02:00 and 02:30 collapsed onto 03:00 and 03:30); times that do not exist are now skipped. And releasing a hold (which needs no consent) while the customer confirms it could cancel the booking they had just confirmed; the release now loses that race (`release_hold` on `CancelBookingRequest`, honoured by the memory and Postgres stores).
- 4e52868: Conformance: providers that seat a party at joined tables can opt in with `combinedTables: { query }` and are then held to the same rules for every table of such a booking: all tables are claimed together, cancelling, expiry and rescheduling free all of them (and no more), a confirmed booking keeps all of them, and no table ends up in two overlapping bookings under concurrent holds. Providers without combined tables leave the option out and are unaffected.

  The demo restaurant (`createDemoRestaurantProvider`, `DEMO=restaurant`) now uses table combinations (tables 6 and 7 for 5 to 8 guests), lunch seatings, a pacing cap, a Sunday walk-in reserve and party-size table time, and sells a lunch offering. Slot grids for the demo change; the bookable library API does not.

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

- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0

## 0.10.0

### Minor Changes

- 12ec3a2: Deposits can now be taken for real. `BookingService` accepts a `payments` provider; the new
  `@openbooking-sh/payments-stripe` is one, using Stripe Checkout. When a deposit is due,
  `confirm_booking` replies `payment_required` with a payment link; once the customer has paid, the
  engine verifies with Stripe that this booking's deposit was paid before it confirms, so an agent
  cannot skip the payment with a made-up token. Cancelling refunds by the cancellation terms
  (`refund_failed` if Stripe is down, and a retry never refunds twice), and a payment that arrives
  after the hold expired is refunded. Studio's "deposit collected" still works.

### Patch Changes

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

- Updated dependencies [dd48af2]
- Updated dependencies [eb99a97]
  - @openbooking-sh/core@0.9.0

## 0.7.0

### Minor Changes

- 7c9ad2d: Rescheduling. `service.reschedule()` and the `reschedule_booking` MCP tool move a confirmed booking to another time for the same service and party size, keeping its id and confirmation code. Allowed while cancellation is still free (`reschedule_not_allowed` after that), with explicit consent. Providers implement the optional `rescheduleBooking`; `BookingRecordStore.move` does it atomically in the memory and Postgres stores (both resources locked in a fixed order).
- e4b56d6: Staff working hours and time off. `VenueConfig.schedules` gives any resource weekly hours (within opening hours) and time off (whole days or exact times, venue-local, DST-safe); availability and holds respect both. `VenueInfo.staff_hours` and the MCP `get_business_info` tool tell agents who works when; time off stays private.

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
