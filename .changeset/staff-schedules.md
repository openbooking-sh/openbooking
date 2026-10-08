---
'@openbooking-sh/provider-memory': minor
'@openbooking-sh/core': minor
'@openbooking-sh/adapter-mcp': minor
---

Staff working hours and time off. `VenueConfig.schedules` gives any resource weekly hours (within opening hours) and time off (whole days or exact times, venue-local, DST-safe); availability and holds respect both. `VenueInfo.staff_hours` and the MCP `get_business_info` tool tell agents who works when; time off stays private.
