# @openbooking-sh/provider-memory

**Configured booking provider.** A `BookingProvider` driven by a plain config: venues, staff or tables, services, opening hours, buffers, deposits and cancellation rules. Bookings go to a pluggable store: memory by default, Postgres via `@openbooking-sh/postgres`. Includes a demo salon and a demo restaurant.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/provider-memory
```

## Usage

```ts
import { createDemoSalonProvider, MemoryBookingProvider } from '@openbooking-sh/provider-memory';

const provider = createDemoSalonProvider();
// or: new MemoryBookingProvider(myConfig, { store: postgresStores(db).bookings })
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
