---
'@openbooking-sh/core': minor
'@openbooking-sh/adapter-mcp': minor
---

Add rescheduling: `BookingService.reschedule()` and the `reschedule_booking` MCP tool. The new slot is held and confirmed first, then the old booking is cancelled under its original cancellation terms (consent required, fee shown before). Webhooks get a single `booking.rescheduled` event (with `data.previous_booking`). Bookings with a paid deposit are not supported yet.
