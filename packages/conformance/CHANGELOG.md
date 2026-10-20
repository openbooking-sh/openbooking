# @openbooking-sh/conformance

## 0.13.0

### Patch Changes

- Updated dependencies [e6a751c]
- Updated dependencies [3825c49]
- Updated dependencies [db42a3d]
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
