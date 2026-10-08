---
'@openbooking-sh/conformance': minor
---

New package: a conformance suite for `BookingProvider`s. `describeProviderConformance()` runs vitest checks that a provider never overbooks (including under parallel holds), lets expired holds go, frees places on cancel and reports failures as `BookingError`s. `runProviderConformance()` returns the results without a test runner.
