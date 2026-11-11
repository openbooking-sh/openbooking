---
'@openbooking-sh/provider-memory': patch
---

`MemoryBookingProvider` no longer records a deposit as paid from a `payment_token` that nobody checked. Before, with no payment provider configured, any token starting with `tok_` (and `manual:…` from any caller) confirmed a booking with the deposit marked paid. Now such a confirm fails with `operation_not_supported`, the hold stays a hold, and a warning is logged once. The pretend `tok_…` tokens need the new `demoPayments: true` option (the demo salon and restaurant factories switch it on), and `manual:…` is accepted only from Studio. If you sell a service with a deposit, set `serviceOptions.payments` (for example `@openbooking-sh/payments-stripe`).
