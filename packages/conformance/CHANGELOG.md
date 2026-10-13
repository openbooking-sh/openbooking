# @openbooking-sh/conformance

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
