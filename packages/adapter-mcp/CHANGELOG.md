# @openbooking-sh/adapter-mcp

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
