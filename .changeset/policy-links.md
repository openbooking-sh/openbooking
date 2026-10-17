---
'@openbooking-sh/hosted': minor
'@openbooking-sh/booking-page': minor
'@openbooking-sh/notifications': minor
'@openbooking-sh/studio': minor
'@openbooking-sh/server': minor
---

Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.
