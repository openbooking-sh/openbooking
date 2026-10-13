---
'@openbooking-sh/core': minor
'@openbooking-sh/payments-stripe': minor
'@openbooking-sh/hosted': minor
'@openbooking-sh/studio': patch
---

Stripe webhooks for hosted deposits. Connecting a Stripe key now also registers a webhook endpoint
(when the key may write Webhook Endpoints). When a customer pays and never returns to the booking
page, the webhook refunds the payment once the hold has expired; while the hold is live it asks
Stripe to deliver again later. New `BookingService.reconcilePayment`, and `StripePayments`
`createWebhook` / `deleteWebhook` plus `verifyWebhook` for checking Stripe's signature.
