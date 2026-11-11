# @openbooking-sh/conformance

## 0.13.0

### Minor Changes

- 4e52868: Conformance: providers that seat a party at joined tables can opt in with `combinedTables: { query }` and are then held to the same rules for every table of such a booking: all tables are claimed together, cancelling, expiry and rescheduling free all of them (and no more), a confirmed booking keeps all of them, and no table ends up in two overlapping bookings under concurrent holds. Providers without combined tables leave the option out and are unaffected.

  The demo restaurant (`createDemoRestaurantProvider`, `DEMO=restaurant`) now uses table combinations (tables 6 and 7 for 5 to 8 guests), lunch seatings, a pacing cap, a Sunday walk-in reserve and party-size table time, and sells a lunch offering. Slot grids for the demo change; the bookable library API does not.

### Patch Changes

- Updated dependencies [6ae5bb8]
- Updated dependencies [de2a7ef]
- Updated dependencies [e6a751c]
- Updated dependencies [7f71337]
- Updated dependencies [8e2e69d]
- Updated dependencies [3825c49]
- Updated dependencies [086199e]
- Updated dependencies [02b8605]
- Updated dependencies [5dc9991]
- Updated dependencies [db42a3d]
- Updated dependencies [cdbb3c4]
- Updated dependencies [074f42f]
  - @openbooking-sh/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0

## 0.10.0

### Patch Changes

- Updated dependencies [12ec3a2]
  - @openbooking-sh/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [dd48af2]
- Updated dependencies [eb99a97]
  - @openbooking-sh/core@0.9.0

## 0.8.0

### Minor Changes

- 44c0ee2: New package: a conformance suite for `BookingProvider`s. `describeProviderConformance()` runs vitest checks that a provider never overbooks (including under parallel holds), lets expired holds go, frees places on cancel and reports failures as `BookingError`s. `runProviderConformance()` returns the results without a test runner.
