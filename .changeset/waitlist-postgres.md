---
'@openbooking-sh/postgres': minor
---

Waitlist store. `PostgresWaitlistStore` (also `postgresStores(db).waitlist`) keeps waitlist entries shared by every instance; claiming an entry locks its row, so two instances cannot offer the same entry twice. Migration 8 adds the `ob_waitlist` table (row level security on); `migrate(db)` applies it.
