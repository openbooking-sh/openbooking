---
'@openbooking-sh/react': minor
---

New package: a React `<BookingWidget>` and headless hooks (`useInfo`, `useAvailability`, `useBooking`) on the typed client. The customer's tick box is the only way `user_confirmed` is sent, and each hold, confirm or cancel keeps one idempotency key until it succeeds.
