---
'@openbooking-sh/core': minor
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/hosted': minor
---

Hosted owners can download everything stored about their business and close their account
(GDPR articles 15 and 17), from the compliance audit.

- Studio, Settings, "Your account": download a JSON file (account, settings, every booking; never the
  password hash or Google tokens) and delete the account with the password. Deleting removes calendar
  links, activity and attribution, idempotency records, all bookings and finally the account, in that
  order, so a failed attempt can be retried.
- New optional store methods: `BookingRecordStore.deleteVenue`, `BusinessStore.delete`,
  `IdempotencyStore.deletePrefix`, `ActivityLog.clear`, `RateLimiter.purge`. Memory and Postgres
  implement them; closing an account refuses with 501 when the stores cannot delete.
- The daily purge also clears expired rate-limit windows, which are keyed by IP address.
