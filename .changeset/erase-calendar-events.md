---
'@openbooking-sh/google-calendar': patch
'@openbooking-sh/hosted': patch
'@openbooking-sh/studio': patch
---

Erasing a customer and the retention purge now also delete the bookings' Google Calendar events, which carried the customer's name, phone, email and notes. A calendar failure never blocks the erasure: the erase answer and the purge answer count the events left behind (`calendar_events_removed`, `calendar_events_failed`), and the activity log gets a `calendar_cleanup` entry per booking (booking id and reason only) so the owner can delete them by hand. `@openbooking-sh/google-calendar` exports `removeBookingEvents` for self-hosted servers. Closing a hosted account now also removes the Stripe webhook endpoint it registered.
