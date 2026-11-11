---
'@openbooking-sh/core': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/client': minor
---

Anti-scalping, all optional (`serviceOptions.guard`; without it nothing changes). Limits per guest (upcoming bookings per venue and per day, by normalised email or phone) and per agent (open holds and active bookings, by client name or a `identifyAgent` hook for a verified id), checked atomically with a ledger write so concurrent holds cannot slip past. Name-bound bookings: with `nonTransferable`, only the venue can put another name on a booking, and the terms say so. Broker-pattern flags (many names from one agent or contact, repeated book-then-cancel) mark a booking for staff without refusing it; they are returned by `service.riskFlags()` and Studio's `/api/bookings`, never in agent or public responses. Two new error codes, `booking_limit_reached` and `not_transferable`. Postgres: `PostgresGuardStore` and migration 8 (`ob_guard`, hashed keys only). Verified agent identity (Web Bot Auth) is separate (OPE-57).
