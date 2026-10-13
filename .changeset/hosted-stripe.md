---
'@openbooking-sh/hosted': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/payments-stripe': minor
---

Hosted businesses can take deposits through their own Stripe account. Studio has an Online
payments card (connect a key, set a deposit percentage); the booking page sends the customer to
Stripe Checkout and confirms the booking when they return. The booking page API now passes
`payment_token` through to the engine.
