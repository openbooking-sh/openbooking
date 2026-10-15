---
'@openbooking-sh/booking-page': minor
---

Add a confirm page (`/confirm/:id`) for a booking an assistant is holding: it shows the time, price and cancellation terms and confirms only when the person presses the button. `BookingPage.confirmUrl(booking)` returns its link, and `GET /api/holds/:id` returns what the page shows (a confirmed booking reveals no code or name).
