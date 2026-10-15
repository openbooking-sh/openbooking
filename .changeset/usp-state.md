---
'@openbooking-sh/postgres': minor
---

Add `PostgresUspState` (also `postgresStores(db).usp`): durable state for the USP adapter, so owners, booking credentials (by hash), replay memory and request keys are shared by every server instance. Migration 4 adds five `ob_usp_*` tables, with row level security like the rest; `migrate(db)` applies it. No customer details are stored in them.
