---
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/postgres': minor
---

Restaurant timing. An offering can set `duration_by_party` (for example 2 guests 90 minutes, 6 guests 2.5 hours); `duration_minutes` stays the default, so existing configs are unchanged. A venue can set `service_periods` (lunch and dinner, optional fixed `seatings`, a `max_online_guests` walk-in reserve) and `pacing` (a cap on guests starting in the same 15 minutes). Limits count held and confirmed bookings, never offer a start that a hold would refuse, and are enforced atomically with the reservation, also in the Postgres store. Custom stores receive the limits as `caps` on the record they insert.
