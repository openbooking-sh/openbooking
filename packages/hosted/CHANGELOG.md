# @openbooking-sh/hosted

## 0.1.1

### Patch Changes

- 77a3ffa: Business, service and staff ids from names with å, æ, ø or accents are now clean: "Bjørn & Åse Frisør" becomes `bjorn-ase-frisor` (was `bjorn-a-se-frisor`). Existing ids don't change.
- Updated dependencies [77a3ffa]
  - @openbooking-sh/studio@0.1.1
