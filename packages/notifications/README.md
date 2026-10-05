# @openbooking-sh/notifications

**Booking emails with calendar invites.** Confirmation and cancellation emails for customers (with an `.ics` invite) and new-booking notices for the business. Sends through Resend or any `Mailer`, deduplicated so agent retries never email twice.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/notifications
```

## Usage

```ts
import { attachNotifications, ResendMailer } from '@openbooking-sh/notifications';

attachNotifications({
  service,
  mailer: new ResendMailer({ apiKey: process.env.RESEND_API_KEY! }),
  config: { from: 'Studio Nord <bookings@example.com>', ownerEmail: 'owner@example.com' },
});
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
