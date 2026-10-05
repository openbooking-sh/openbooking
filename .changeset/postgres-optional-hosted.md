---
'@openbooking-sh/postgres': patch
---

Fix: loading `@openbooking-sh/postgres` no longer requires `@openbooking-sh/hosted`. Apps that use Postgres without hosted crashed at startup with `ERR_MODULE_NOT_FOUND`.
