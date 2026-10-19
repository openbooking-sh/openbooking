---
'@openbooking-sh/postgres': patch
---

`migrate()` recognises an up-to-date database with a single query instead of a transaction, an advisory lock and three more statements, which trims serverless cold starts by four database round trips. Databases with pending migrations (including fresh ones) still take the lock, so instances booting at the same time stay serialised.
