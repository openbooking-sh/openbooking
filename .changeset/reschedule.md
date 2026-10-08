---
'@openbooking-sh/core': minor
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/adapter-mcp': minor
---

Rescheduling. `service.reschedule()` and the `reschedule_booking` MCP tool move a confirmed booking to another time for the same service and party size, keeping its id and confirmation code. Allowed while cancellation is still free (`reschedule_not_allowed` after that), with explicit consent. Providers implement the optional `rescheduleBooking`; `BookingRecordStore.move` does it atomically in the memory and Postgres stores (both resources locked in a fixed order).
