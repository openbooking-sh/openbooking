# @openbooking-sh/google-calendar

**Google Calendar sync.** OAuth for Google Calendar, busy times that block availability, and bookings written to the calendar as events (updated and deleted with the booking).

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/google-calendar
```

## Usage

```ts
import {
  googleAuthUrl,
  exchangeCode,
  attachCalendarSync,
  googleBusySource,
} from '@openbooking-sh/google-calendar';
```

See `@openbooking-sh/hosted` for a complete wiring.

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
