---
'@openbooking-sh/core': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/hosted': patch
---

The same idempotency key sent to two server instances at the same instant now runs once. Before, both instances ran, so one customer could end up with two holds (on two staff members; no slot was ever given out twice). `IdempotencyStore` gets an optional `claim()` and `release()`: the first instance to claim the key runs, the other waits for its result and replays it, and a claim whose instance died expires after 60 seconds. `PostgresIdempotencyStore` implements them with one `insert … on conflict` statement (no migration), and hosted passes them through its per-business key prefix. A custom store without `claim()` keeps the old per-process behaviour.
