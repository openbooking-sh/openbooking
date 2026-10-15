---
'@openbooking-sh/adapter-usp': minor
---

First release of the USP adapter: the Universal Scheduling Protocol (a draft standard from Wix and Stripe) over REST. Profile at `/.well-known/usp`, catalog, availability, holds and bookings. Platforms sign in with a key they make themselves (RFC 9449 DPoP proofs, no accounts), booking credentials are bound to that key, and each business chooses how a booking becomes real: the customer confirms on the booking page (default) or the assistant books immediately. `createUsp()` wires it for one business. Follows a draft spec and may change with it.
