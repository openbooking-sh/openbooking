# @openbooking-sh/payments-stripe

## 0.13.0

### Patch Changes

- Updated dependencies [e6a751c]
- Updated dependencies [3825c49]
- Updated dependencies [db42a3d]
  - @openbooking-sh/core@0.13.0

## 0.12.0

### Minor Changes

- e3fac6c: Stripe webhooks for hosted deposits. Connecting a Stripe key now also registers a webhook endpoint
  (when the key may write Webhook Endpoints). When a customer pays and never returns to the booking
  page, the webhook refunds the payment once the hold has expired; while the hold is live it asks
  Stripe to deliver again later. New `BookingService.reconcilePayment`, and `StripePayments`
  `createWebhook` / `deleteWebhook` plus `verifyWebhook` for checking Stripe's signature.

### Patch Changes

- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0

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
