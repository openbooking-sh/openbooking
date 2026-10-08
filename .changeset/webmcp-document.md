---
'@openbooking-sh/booking-page': patch
---

WebMCP follows the current draft: tools register on `document.modelContext` (falling back to `navigator.modelContext`), resolve to JSON strings and reject on errors, and carry `readOnlyHint` / `consequentialHint` annotations. Older builds keep the MCP-style content arrays.
