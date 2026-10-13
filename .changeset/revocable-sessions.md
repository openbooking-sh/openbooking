---
'@openbooking-sh/hosted': minor
'@openbooking-sh/studio': patch
---

Logging out of Studio now ends every session of the account on the server, so a copied token stops
working at once (it used to live on until it expired). Session tokens now last 7 days instead of 30.
