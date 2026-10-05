---
'@openbooking-sh/hosted': patch
'@openbooking-sh/studio': patch
---

Business, service and staff ids from names with å, æ, ø or accents are now clean: "Bjørn & Åse Frisør" becomes `bjorn-ase-frisor` (was `bjorn-a-se-frisor`). Existing ids don't change.
