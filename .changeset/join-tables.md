---
'@openbooking-sh/core': minor
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/postgres': minor
'@openbooking-sh/adapter-mcp': minor
'@openbooking-sh/studio': minor
---

Join tables for larger parties. `table_combinations` on a venue lists tables that may be pushed together (for example t6 + t7 seats 5 to 8, with an optional extra turnover and label). A party gets the smallest single table that fits as before; joined tables are offered only when no single table is free, choosing the pair that wastes the fewest seats. One booking occupies all its tables, claimed all-or-nothing in the memory and Postgres stores, and cancel, expiry and reschedule free or move all of them. Slots keep `resource` as the first table and add `additional_resources`; the label reads "Tables T6 and T7 together" and the MCP `next_step` tells the agent to say so. Studio shows a joined booking on each table's column. Postgres adds migration 7 (`extra_resource_ids`). Existing configs and stored bookings are unchanged.
