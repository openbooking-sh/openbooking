---
'@openbooking-sh/booking-page': minor
'@openbooking-sh/notifications': minor
'@openbooking-sh/client': patch
---

Payment terms where the customer pays, and a clearer way out. The booking page's pay button names the deposit amount, and the lines under it say what happens to the deposit if they cancel. The confirmation email for a paid booking says what was paid and what happens to the deposit on cancellation. The manage page says what cancelling costs right now, and one press cancels while it is free (it still asks once more when a fee applies). The booking API's booking detail gains `cancel_now` (free, fee, refund) for confirmed bookings, and the client types follow.
