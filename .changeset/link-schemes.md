---
'@openbooking-sh/studio': patch
'@openbooking-sh/booking-page': patch
'@openbooking-sh/hosted': patch
---

Only http(s) business links. Studio now refuses a website that is not `http:` or `https:` (a `javascript:` or `data:` link would run on the booking page). The booking page, its JSON API, `llms.txt`, the JSON-LD (`sameAs`, `hasMenu`) and the hosted venue URL leave out any other scheme, so a website saved before this change is simply not linked. New export: `httpUrl()` from `@openbooking-sh/booking-page`.
