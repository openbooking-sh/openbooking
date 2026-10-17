---
'@openbooking-sh/client': minor
---

New package: a small typed `fetch` client for the booking API of one business (`createClient({ baseUrl })`): read services, find free times, hold, confirm, release and cancel. No dependencies; works in browsers, edge functions and Node. Every write carries an idempotency key (generated, or pass your own to retry safely), consent is explicit (`user_confirmed: true`), and every failure is an `OpenBookingError` with a code and what to do next.
