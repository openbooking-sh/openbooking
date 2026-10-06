---
'@openbooking-sh/core': minor
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/adapter-mcp': minor
'@openbooking-sh/server': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/hosted': minor
'@openbooking-sh/postgres': minor
'create-openbooking': minor
---

Better for agents and safer in public, from a fresh-eyes test of the SDK:

- New MCP tool `get_business_info`: services, staff, opening hours and booking window.
- Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
- `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
- New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
- Providers can expose opening hours with `getVenueInfo`.
