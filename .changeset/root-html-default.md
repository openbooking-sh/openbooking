---
'@openbooking-sh/server': patch
---

The business root (`/`) serves the booking page unless the client asks for JSON, so AI crawlers that send `Accept: */*` see the business and its schema.org data. Adds `Vary: Accept`.
