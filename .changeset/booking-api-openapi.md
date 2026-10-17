---
'@openbooking-sh/booking-page': minor
---

The booking page API now describes itself: an OpenAPI 3.1 document at `<page>/book/api/openapi.json`, generated from zod schemas that every real response is tested against. The schemas are exported as `api` and the generator as `buildOpenApi`. Call the API with the new `@openbooking-sh/client`.
