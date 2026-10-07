---
'create-openbooking': patch
---

New projects depend on each package's own version. 0.2.0 asked for `@openbooking-sh/postgres@^0.2.0`, which doesn't exist (postgres went from 0.1.1 to 0.3.0), so `npm install` failed.
