---
'@openbooking-sh/core': minor
'@openbooking-sh/studio': minor
---

Consent evidence in the agent log. A confirm, move or cancellation that went through on `user_confirmed: true` now emits a `consent` field on its `BookingEvent` (`ConsentEvidence`): the service, time, party size, price, deposit and cancellation terms the booking carried at that moment, and for a cancellation the fee and refund. Studio keeps it on the activity entry (`ActivityEntry.consent`, no database change: entries are JSON) and shows it under the action in the Agent log and in a booking's history. It holds no customer name, email or phone. Replays and releasing a hold carry none.
