---
'@openbooking-sh/core': patch
'@openbooking-sh/provider-memory': patch
---

Two fixes found by the new concurrency and daylight-saving fuzz tests. On the night clocks jump forward, a venue open through the missing hour was offered duplicate slots (02:00 and 02:30 collapsed onto 03:00 and 03:30); times that do not exist are now skipped. And releasing a hold (which needs no consent) while the customer confirms it could cancel the booking they had just confirmed; the release now loses that race (`release_hold` on `CancelBookingRequest`, honoured by the memory and Postgres stores).
