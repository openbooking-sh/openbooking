# @openbooking-sh/conformance

**Conformance suite for booking providers.** Vitest checks that a `BookingProvider` keeps the promises the engine relies on: slots are never overbooked (even with parallel holds), expired holds stop blocking, cancellations free the place, and every failure is a `BookingError` with the right code. Optional methods (`updateBooking`, `rescheduleBooking`, `listBookings`) are tested only when implemented.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/conformance
```

## Usage

```ts
import { describeProviderConformance } from '@openbooking-sh/conformance/vitest';

describeProviderConformance('MySystemProvider', {
  create: () => new MySystemProvider(testConfig), // a fresh, empty provider per test
  now: new Date('2030-06-03T08:00:00Z'), // before the date you search
  query: { date: '2030-06-04', party_size: { total: 1 } }, // must return open slots
});
```

Also exports `runProviderConformance(options)`, which returns a pass/fail result per check without a test runner.

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
