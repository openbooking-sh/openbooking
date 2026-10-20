---
'@openbooking-sh/adapter-usp': minor
'@openbooking-sh/server': minor
'@openbooking-sh/hosted': minor
---

USP over MCP. `createUsp({ mcp: true })` serves the spec's `usp_*` tools at `<path>/mcp` (a stateless Streamable HTTP MCP endpoint) and advertises it in the profile. It is the REST engine behind a different wrapper: same consent modes, idempotency, ownership, capability negotiation and state. Platforms authenticate with the MCP form of the key proof inside `_meta.usp.authorization`, results come back as `structuredContent` plus text, and protocol errors are JSON-RPC errors with `data.code`. Off by default: `usp: { mcp: true }` in the server, `uspMcp` in the hosted app.

Also: `If-Match` (REST) and `_meta.usp.if_match` (MCP) on a booking write are now refused with `revision_mismatch` (412), because bookings carry no revision to match; REST used to ignore them.
