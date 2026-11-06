# @openbooking-sh/client

## 0.13.0

### Minor Changes

- 3d98490: New package: a small typed `fetch` client for the booking API of one business (`createClient({ baseUrl })`): read services, find free times, hold, confirm, release and cancel. No dependencies; works in browsers, edge functions and Node. Every write carries an idempotency key (generated, or pass your own to retry safely), consent is explicit (`user_confirmed: true`), and every failure is an `OpenBookingError` with a code and what to do next.

### Patch Changes

- bb06329: Payment terms where the customer pays, and a clearer way out. The booking page's pay button names the deposit amount, and the lines under it say what happens to the deposit if they cancel. The confirmation email for a paid booking says what was paid and what happens to the deposit on cancellation. The manage page says what cancelling costs right now, and one press cancels while it is free (it still asks once more when a fee applies). The booking API's booking detail gains `cancel_now` (free, fee, refund) for confirmed bookings, and the client types follow.
