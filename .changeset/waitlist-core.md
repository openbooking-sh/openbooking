---
'@openbooking-sh/core': minor
---

Waitlist (OPE-20). `new Waitlist({ service })` lets a customer join for a full day and be offered a freed slot: when a booking is cancelled or a hold lapses, the first matching entry gets a real hold for a short window (`offerTtlSeconds`, default 15 minutes) and a `WaitlistEvent` of type `offered`, so the customer can be told. Accepting is the normal `confirm` with `user_confirmed`. Joining is refused while something is bookable, needs `user_confirmed` and is idempotent. Entries are claimed atomically in a `WaitlistStore` (`MemoryWaitlistStore` included), so a slot is offered once and an entry holds one slot; `sweep()` retires stale entries and deletes finished ones after `retentionDays`; `exportCustomer` and `eraseCustomer` cover customer data requests. `BookingService.hold` takes an optional `{ ttlSeconds }`.
