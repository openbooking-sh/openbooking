# @openbooking-sh/payments-stripe

## 0.11.0

### Minor Changes

- 10e30b3: Hosted businesses can take deposits through their own Stripe account. Studio has an Online
  payments card (connect a key, set a deposit percentage); the booking page sends the customer to
  Stripe Checkout and confirms the booking when they return. The booking page API now passes
  `payment_token` through to the engine.

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
