# @openbooking-sh/react

**React booking widget and hooks.** A drop-in `<BookingWidget>` and the hooks under it (`useInfo`, `useAvailability`, `useBooking`), built on `@openbooking-sh/client`. The customer picks a time (held for a few minutes), reads the price and cancellation terms, ticks a box and confirms: nothing is booked before they do. Each action carries one idempotency key until it succeeds, so a retry after a network error never books twice. Times that need an online deposit are sent to the booking page. Works with React 18 and 19, renders on the server, and has no other dependencies.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/react
```

## Usage

```ts
import { BookingWidget } from '@openbooking-sh/react';

export function Book() {
  return (
    <BookingWidget
      baseUrl="https://app.openbooking.sh/b/studio-nord/book"
      onBooked={(booking) => console.log(booking.confirmation_code)}
    />
  );
}

// Or build your own form on the hooks:
// <OpenBookingProvider baseUrl="…"> … useAvailability({ date, service }) · useBooking()
```

Style it with CSS variables (`--ob-accent`, `--ob-bg`, `--ob-fg`, `--ob-radius`, `--ob-font`), or pass `unstyled` and write your own CSS against the `ob-*` class names and `data-ob-*` attributes.

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
