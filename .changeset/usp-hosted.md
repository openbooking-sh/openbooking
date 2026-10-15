---
'@openbooking-sh/hosted': minor
---

Owners can let AI assistants and platforms book them through USP: Studio → Settings → AI assistants, off by default, either the customer confirms on a page or the assistant books immediately. The profile is at `/b/{id}/.well-known/usp`. Businesses saved before the setting count as off. Pass `uspState` (`postgresStores(db).usp`) when running more than one instance; the Vercel entry does.
