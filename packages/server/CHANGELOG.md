# @openbooking-sh/server

## 0.6.0

### Patch Changes

- 899afde: The business root (`/`) serves the booking page unless the client asks for JSON, so AI crawlers that send `Accept: */*` see the business and its schema.org data. Adds `Vary: Accept`.

## 0.2.0

### Minor Changes

- 4d9f0fc: Better for agents and safer in public, from a fresh-eyes test of the SDK:

  - New MCP tool `get_business_info`: services, staff, opening hours and booking window.
  - Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
  - `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
  - New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
  - Providers can expose opening hours with `getVenueInfo`.

### Patch Changes

- Updated dependencies [4d9f0fc]
  - @openbooking-sh/core@0.2.0
  - @openbooking-sh/adapter-mcp@0.2.0
  - @openbooking-sh/studio@0.2.0
  - @openbooking-sh/booking-page@0.2.0
  - @openbooking-sh/adapter-a2a@0.2.0
  - @openbooking-sh/adapter-ucp@0.2.0
