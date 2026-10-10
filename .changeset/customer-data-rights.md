---
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/hosted': minor
---

Customer data rights (GDPR articles 15 and 17) and retention, from the compliance audit.

- `BookingRecordStore` gets an optional `anonymize(query, now)`: it removes the customer's name,
  contact details and notes from bookings and keeps the booking itself. Implemented for the memory
  and Postgres stores. Upcoming bookings (held or confirmed, not yet ended) are kept and counted, and
  a query must name a customer or an age, so it can never erase everything.
- Studio gets `dataRights` (an adapter) and, when set, `POST /api/customers/export` and
  `POST /api/customers/erase`, plus a "Customer data" card in Settings. POST so an email address
  or phone number stays out of URLs and logs.
- Hosted wires it up, and removes customer data from bookings that ended more than `retentionDays`
  ago (default 730) through `GET /api/maintenance/purge`, which needs `cronSecret` (`CRON_SECRET`).
  `vercel.json` runs it daily.
