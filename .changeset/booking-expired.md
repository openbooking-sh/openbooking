---
'@openbooking-sh/core': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/hosted': minor
'@openbooking-sh/server': patch
---

Add the `booking.expired` webhook event, and an `expire` engine event, for holds that lapse without being confirmed or cancelled. Nothing runs when a hold expires, so the event is sent when a read first notices it or when `service.sweepExpired()` runs (call it from a cron or timer to report lapses nobody reads). Each expiry is announced at most once across instances through a new `expiryClaims` option (hosted reuses its email dedupe log; pass `PostgresNotificationLog` when running several instances on one database). The event carries no actor, and Studio shows it as a system entry.
