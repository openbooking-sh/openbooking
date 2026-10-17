# @openbooking-sh/client

**Typed client for the booking API.** A small, typed `fetch` client for the booking API of one business: read its services, find free times, hold, confirm and cancel. No dependencies; works in browsers, edge functions and Node. Every write carries an idempotency key, consent is explicit (`user_confirmed: true`), and every failure is an `OpenBookingError` with a code and what to do next. The API is described by an OpenAPI 3.1 document at `<booking page>/book/api/openapi.json`, for every other language.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/client
```

## Usage

```ts
import { createClient } from '@openbooking-sh/client';

const booking = createClient({ baseUrl: 'https://app.openbooking.sh/b/studio-nord/book' });

const { slots } = await booking.availability({ date: '2026-10-16', service: 'haircut' });
const hold = await booking.hold({ slot_id: slots[0].slot_id }); // reserved for a few minutes

// Show the customer the time, price and cancellation terms. Only when they say yes:
const confirmed = await booking.confirm({
  booking_id: hold.booking_id,
  user_confirmed: true,
  customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
});
console.log(confirmed.confirmation_code);
```

Pass your own `idempotency_key` (and keep it) to retry a write safely after a network error: the same key never books twice.

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
