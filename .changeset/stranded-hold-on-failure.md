---
'@openbooking-sh/core': patch
---

A hold that fails after the booking system made it no longer blocks its own retry. When the dietary note or the idempotency record could not be written, the caller got an error but the hold stayed, so a retry with the same idempotency key was refused with `slot_unavailable` until the hold ran out (about ten minutes); on a slot with room for several it took a second place instead. The hold is now released before the error is returned, so the retry gets a fresh hold and the slot has exactly one. `IdempotencyGuard.run()` takes an optional `undo` callback for this, called when a result cannot be recorded.
