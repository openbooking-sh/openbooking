---
'@openbooking-sh/core': patch
---

Webhook events now reach each endpoint in the order they happened. Deliveries used to run
concurrently, so a cancellation could arrive before the confirmation it cancelled. An endpoint that
keeps failing holds back its later events until the earlier one succeeds or gives up.
