---
'@openbooking-sh/server': minor
---

Add `usp` to `createOpenBookingApp`: mounts USP (`/usp`, `/.well-known/usp`) for assistants and platforms that book through the Universal Scheduling Protocol. Off unless set; by default the customer confirms on the booking page (`consent: 'action'`). Calls from USP platforms are credited to their own channel in Studio.
