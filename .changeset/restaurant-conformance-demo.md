---
'@openbooking-sh/conformance': minor
'@openbooking-sh/provider-memory': patch
---

Conformance: providers that seat a party at joined tables can opt in with `combinedTables: { query }` and are then held to the same rules for every table of such a booking: all tables are claimed together, cancelling, expiry and rescheduling free all of them (and no more), a confirmed booking keeps all of them, and no table ends up in two overlapping bookings under concurrent holds. Providers without combined tables leave the option out and are unaffected.

The demo restaurant (`createDemoRestaurantProvider`, `DEMO=restaurant`) now uses table combinations (tables 6 and 7 for 5 to 8 guests), lunch seatings, a pacing cap, a Sunday walk-in reserve and party-size table time, and sells a lunch offering. Slot grids for the demo change; the bookable library API does not.
