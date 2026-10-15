---
'@openbooking-sh/server': patch
'@openbooking-sh/hosted': patch
---

USP: platform profiles are now fetched (safely, public internet only) and capabilities negotiated. `usp.platformProfiles` on `createOpenBookingApp` and `uspPlatformProfiles` on `createHostedApp` take a fetcher or `false`; hosted shares one fetcher, and so one cache, across all businesses.
