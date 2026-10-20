# @openbooking-sh/core

## 0.13.0

### Minor Changes

- e6a751c: Add the `booking.expired` webhook event, and an `expire` engine event, for holds that lapse without being confirmed or cancelled. Nothing runs when a hold expires, so the event is sent when a read first notices it or when `service.sweepExpired()` runs (call it from a cron or timer to report lapses nobody reads). Each expiry is announced at most once across instances through a new `expiryClaims` option (hosted reuses its email dedupe log; pass `PostgresNotificationLog` when running several instances on one database). The event carries no actor, and Studio shows it as a system entry.

### Patch Changes

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
