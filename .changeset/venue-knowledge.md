---
'@openbooking-sh/core': minor
'@openbooking-sh/adapter-mcp': minor
'@openbooking-sh/adapter-usp': minor
'@openbooking-sh/adapter-a2a': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/client': minor
'@openbooking-sh/provider-memory': minor
---

Venue knowledge for assistants. A venue can carry an optional `knowledge` block: cuisine, a short about text, a menu (link and a few dishes with prices in minor units), dietary options, atmosphere, accessibility features, parking, dress code, languages and a children policy. `get_business_info` (MCP and A2A) returns it, the booking page's `/info` returns it when present, the schema.org data adds `servesCuisine`, `hasMenu` and `amenityFeature`, and the USP catalog passes it through each service's `metadata` under `sh.openbooking.venue_knowledge` (USP has no dedicated field). The facts always travel with a `safety_note` telling the assistant that dietary options are offers, not allergen guarantees, and that guests must confirm allergies with the venue; the model has no allergen-free field. The demo restaurant now has knowledge. Existing venues, configs and stored hosted settings are unchanged.
