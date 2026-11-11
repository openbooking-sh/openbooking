---
'@openbooking-sh/hosted': patch
'@openbooking-sh/adapter-usp': patch
---

The website importer only fetches public addresses, however the address is written. An IPv4 address written as IPv6 was treated as public; it is now refused, along with the other private and special-use ranges, on the address given and on every redirect. The importer also connects to the address it checked, so a second DNS answer cannot point the request elsewhere. It shares these rules with the USP profile fetch: `@openbooking-sh/adapter-usp` exports `resolvePublicAddress`, and `isSpecialUseAddress` now also refuses "IPv4-compatible" IPv6 addresses (`::a.b.c.d`) and scoped addresses.
