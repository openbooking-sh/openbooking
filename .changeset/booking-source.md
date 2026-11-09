---
'@openbooking-sh/core': minor
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/hosted': minor
---

Booking source. Every new booking records where it came from: `source: { channel, agent? }`, with the channel one of `mcp`, `ucp`, `a2a`, `usp`, `website`, `embed`, `phone`, `walk_in` or `other`, and the assistant's own name for itself when the protocol gives one (MCP client name, UCP/USP platform host, browser family). It is set when the hold is made and kept through confirm, reschedule and cancel. The assistant name is self-reported and not verified. Bookings made before this have no source and show as "Unknown". It never changes a price, deposit or cancellation term.

Studio shows the source in the booking list and drawer, can filter by it, counts bookings per source for a date range (Insights), exports bookings as CSV (no contact details), and the new-booking form asks staff whether it came by phone or walk-in. Hosted analytics carry only the channel and a coarse assistant group (ChatGPT, Gemini, ...), never customer data. The embed script sends `x-openbooking-source: embed`; a provider that stores bookings should keep `source` from `CreateHoldRequest`.
