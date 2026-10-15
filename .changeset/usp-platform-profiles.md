---
'@openbooking-sh/adapter-usp': minor
---

Fetch and check platform profiles. On a privileged call the platform's profile (named in `USP-Agent`) is fetched with a hardened fetcher that can only reach the public internet (https on 443 to a host name, every DNS answer must be public, the connection goes to the validated address with TLS checked against the host name, no redirects, time and size limits, cached for the profile's `Cache-Control`), and the business uses only the capabilities both sides have: `version_unsupported` for a newer platform, `capabilities_incompatible` when nothing is usable. `createUsp({ platformProfiles })` takes your own fetcher or `false`; the default is the hardened one. `createPopAuthenticator({ fetchProfile })` replaces `checkProfile`.
