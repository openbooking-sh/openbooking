---
'@openbooking-sh/adapter-mcp': minor
'@openbooking-sh/server': minor
---

Waitlist tools. Pass a core `Waitlist` as `waitlist` to `createMcpServer`, `createMcpHttpHandler` or `createOpenBookingApp` to add `join_waitlist`, `check_waitlist` and `leave_waitlist` (and a short paragraph in the server instructions). Without one nothing changes. Every response carries a `next_step`; an offered entry shows the held booking and tells the agent to confirm it only after the user approves.
