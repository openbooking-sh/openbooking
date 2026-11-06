---
'@openbooking-sh/payments-stripe': patch
'@openbooking-sh/studio': patch
---

A refund now checks what Stripe has already refunded on the payment and sends only the difference, so a partial refund retried after Stripe's 24 hour idempotency window no longer pays the customer twice (and refunds made by hand in the Stripe dashboard count). If the refunds already made cannot be read, nothing is refunded and the call fails instead of guessing; the Stripe key must be able to read Refunds. Studio's booking drawer gains a Payment line: waiting, not paid, paid online or in person, and the refund and amount kept after a cancellation.
