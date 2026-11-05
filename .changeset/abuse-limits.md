---
'@openbooking-sh/hosted': patch
'@openbooking-sh/core': patch
---

Abuse limits for hosted. Request bodies over 256 KB get a 413 (`maxBodyBytes` to change it). Holds are now counted in the shared rate limiter (Postgres in production), per business and IP, so the limit holds across instances and cold starts instead of resetting in each process. Sign-ups also have a cap of 100 an hour across all addresses, counted after the per-IP check. In core, customer names (100), email (254), ids (200) and payment tokens (500) in booking requests have length caps.
