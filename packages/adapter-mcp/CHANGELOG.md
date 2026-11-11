# @openbooking-sh/adapter-mcp

## 0.13.0

### Minor Changes

- 086199e: Guest profiles, allergy notes and a pre-shift summary, all staff-only.

  - **Allergy and dietary notes.** `hold_slot` (MCP), the booking page's confirm request and `service.hold` / `service.update` take an optional `dietary_notes` (300 characters). It is stored apart from the booking (a new `GuestStore`, `ob_dietary_notes` in Postgres), so no protocol response, email, webhook event, activity entry, analytics event or idempotency record can carry it. Studio shows it on the booking and in the pre-shift summary. It is deleted a day after the visit (`dietaryNoteRetentionDays`, hosted `dietaryNoteRetentionDays`; the daily purge does it), when the booking is cancelled or lapses, with the customer's erasure, and with the account. MCP agents are told it is optional and to use only what the guest said; `notes` no longer suggests allergies.
  - **Guest profiles.** Staff set tags, notes and a VIP flag per guest in Studio (booking drawer, Customers). A guest is a per-business hash of their email (or phone), so nothing links guests across businesses and the profile table holds no contact detail. Visit count and last visit come from the business's own bookings. Profiles are in the customer export, removed on erasure and when no booking with that guest's details is left.
  - **Pre-shift summary.** `GET /studio/api/preshift?date=` and a Pre-shift view: covers, party sizes, VIPs, first-time versus returning guests, allergy notes.
  - **Postgres.** Migration 8 adds `ob_dietary_notes` and `ob_guest_profiles` (row level security on). `postgresStores(db).guests` is the store; pass it as `guests` to `createHostedApp` and `serviceOptions`.

- 02b8605: Join tables for larger parties. `table_combinations` on a venue lists tables that may be pushed together (for example t6 + t7 seats 5 to 8, with an optional extra turnover and label). A party gets the smallest single table that fits as before; joined tables are offered only when no single table is free, choosing the pair that wastes the fewest seats. One booking occupies all its tables, claimed all-or-nothing in the memory and Postgres stores, and cancel, expiry and reschedule free or move all of them. Slots keep `resource` as the first table and add `additional_resources`; the label reads "Tables T6 and T7 together" and the MCP `next_step` tells the agent to say so. Studio shows a joined booking on each table's column. Postgres adds migration 7 (`extra_resource_ids`). Existing configs and stored bookings are unchanged.
- cdbb3c4: Venue knowledge for assistants. A venue can carry an optional `knowledge` block: cuisine, a short about text, a menu (link and a few dishes with prices in minor units), dietary options, atmosphere, accessibility features, parking, dress code, languages and a children policy. `get_business_info` (MCP and A2A) returns it, the booking page's `/info` returns it when present, the schema.org data adds `servesCuisine`, `hasMenu` and `amenityFeature`, and the USP catalog passes it through each service's `metadata` under `sh.openbooking.venue_knowledge` (USP has no dedicated field). The facts always travel with a `safety_note` telling the assistant that dietary options are offers, not allergen guarantees, and that guests must confirm allergies with the venue; the model has no allergen-free field. The demo restaurant now has knowledge. Existing venues, configs and stored hosted settings are unchanged.
- 074f42f: Waitlist tools. Pass a core `Waitlist` as `waitlist` to `createMcpServer`, `createMcpHttpHandler` or `createOpenBookingApp` to add `join_waitlist`, `check_waitlist` and `leave_waitlist` (and a short paragraph in the server instructions). Without one nothing changes. Every response carries a `next_step`; an offered entry shows the held booking and tells the agent to confirm it only after the user approves.

### Patch Changes

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

### Patch Changes

- 12ec3a2: Deposits can now be taken for real. `BookingService` accepts a `payments` provider; the new
  `@openbooking-sh/payments-stripe` is one, using Stripe Checkout. When a deposit is due,
  `confirm_booking` replies `payment_required` with a payment link; once the customer has paid, the
  engine verifies with Stripe that this booking's deposit was paid before it confirms, so an agent
  cannot skip the payment with a made-up token. Cancelling refunds by the cancellation terms
  (`refund_failed` if Stripe is down, and a retry never refunds twice), and a payment that arrives
  after the hold expired is refunded. Studio's "deposit collected" still works.
- Updated dependencies [12ec3a2]
  - @openbooking-sh/core@0.10.0

## 0.9.0

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
