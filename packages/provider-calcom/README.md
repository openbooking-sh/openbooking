# @openbooking-sh/provider-calcom

**Cal.com connector (beta).** A `BookingProvider` for Cal.com (hosted) and self-hosted Cal.com, via the Cal.com API v2. Makes an existing Cal.com account bookable by AI agents with holds, consent and cancellation terms.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/provider-calcom
```

## Usage

```ts
import { CalcomBookingProvider } from '@openbooking-sh/provider-calcom';

const provider = new CalcomBookingProvider({
  apiKey: process.env.CAL_API_KEY!,
  venue: { id: 'venue', name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
});
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
