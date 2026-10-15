# @openbooking-sh/adapter-usp

**Universal Scheduling Protocol (draft).** Exposes a `BookingService` over the Universal Scheduling Protocol (USP), the draft standard from Wix and Stripe that lets any platform or AI assistant discover and book a business: the profile at `/.well-known/usp`, the catalog, availability, holds and bookings over REST. Platforms sign in with a key they make themselves (no accounts), and each business chooses how a booking becomes real: the customer confirms on a page (default), or the assistant books immediately. Follows a draft spec and may change with it. Most apps use it through `@openbooking-sh/server` (`usp: {}`) or hosted OpenBooking.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/adapter-usp
```

## Usage

```ts
import { createUsp } from '@openbooking-sh/adapter-usp';

const usp = createUsp({
  service,
  baseUrl: 'https://bistro.example.com', // the public address platforms sign
  continueUrl: (b) => bookingPage.confirmUrl(b), // where the customer confirms a held booking
  state: postgresStores(db).usp, // shared by every instance when you run more than one
});

app.route(usp.path, usp.router);
app.get('/.well-known/usp', async (c) => c.json(await usp.profile()));
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
