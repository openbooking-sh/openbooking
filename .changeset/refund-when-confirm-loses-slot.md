---
'@openbooking-sh/core': patch
---

Refund the deposit in the same `confirm_booking` call when the customer has paid and the booking can then no longer be made (the hold lapsed while the payment was checked and someone else took the time). The error now says the booking was not made and that the deposit is being refunded, or, if the refund itself failed, answers `refund_failed`, logs it for the business and retries on the next call. Before, the money only went back on a retry or from the Stripe webhook. A confirm that went through, or whose hold is still live, is never refunded: the engine reads the booking again before deciding.
