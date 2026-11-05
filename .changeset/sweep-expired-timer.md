---
'@openbooking-sh/server': minor
'@openbooking-sh/hosted': minor
---

Announce lapsed holds without anyone having to look at them. `server` gets an opt-in `sweepExpiredEveryMs` option that runs `service.sweepExpired()` on a timer (long-running processes; the timer never keeps the process alive and stops on `close()`). `hosted` gets `GET /api/maintenance/sweep` and `hosted.sweepExpiredHolds()`, protected by the same `CRON_SECRET` as the purge endpoint, and the daily purge now also sweeps, so `booking.expired` and its emails go out even on a daily cron. For minute-level timeliness, point a more frequent cron at `/api/maintenance/sweep` (Vercel Hobby only allows daily crons).
