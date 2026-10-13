# @openbooking-sh/payments-stripe

**Stripe deposits.** Takes the deposit of a booking on a Stripe Checkout page and refunds it by the cancellation terms. The engine only confirms a booking after Stripe says the deposit was paid, for that booking and that amount, so an agent can never skip the payment with a made-up token. Plain `fetch`, no Stripe SDK.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/payments-stripe
```

## Usage

```ts
import { BookingService } from '@openbooking-sh/core';
import { StripePayments } from '@openbooking-sh/payments-stripe';

const service = new BookingService({
  provider,
  payments: new StripePayments({
    secretKey: process.env.STRIPE_SECRET_KEY!,
    successUrl: 'https://example.com/booked',
    cancelUrl: 'https://example.com/book',
  }),
});
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
