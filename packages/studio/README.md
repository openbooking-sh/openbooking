# @openbooking-sh/studio

**OpenBooking Studio.** The dashboard for the people running the business: calendar per staff member, bookings, customers, services, settings, insights, and a log of every AI agent call. Mount it on any Hono app; protect it with a token.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/studio
```

## Usage

```ts
import { createStudio } from '@openbooking-sh/studio';

const studio = createStudio({ service, token: process.env.STUDIO_TOKEN });
app.route('/studio', studio.app);
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
