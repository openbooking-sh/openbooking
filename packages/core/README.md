# @openbooking-sh/core

**The booking engine.** The domain model, the `BookingProvider` interface every booking system implements, and `BookingService`: the agent-safe engine that every protocol adapter runs through. It enforces holds that expire, idempotent retries, explicit customer consent, and cancellation and deposit terms shown before anything is confirmed.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/core
```

## Usage

```ts
import { BookingService } from '@openbooking-sh/core';

const service = new BookingService({ provider: myProvider });

const { slots } = await service.searchAvailability({
  date: '2026-10-09',
  party_size: { total: 1 },
});
const hold = await service.hold({
  slot_id: slots[0].slot_id,
  idempotency_key: crypto.randomUUID(),
});
const booking = await service.confirm({
  booking_id: hold.booking_id,
  idempotency_key: crypto.randomUUID(),
  user_confirmed: true, // only after the customer said yes to time, price and terms
  customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
});
```

Implement `BookingProvider` (`listVenues`, `searchAvailability`, `createHold`, `confirmHold`, `getBooking`, `cancelBooking`) to make any booking system bookable by AI agents.

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
