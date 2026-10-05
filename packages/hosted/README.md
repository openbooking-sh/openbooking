# @openbooking-sh/hosted

**Hosted, multi-business OpenBooking.** Everything behind app.openbooking.sh: sign-up and a self-serve setup wizard (with website import), Studio per business, booking pages, one MCP app that finds and books any listed business (`find_business`), password reset, email confirmation, rate limits, Google Calendar, emails, analytics and Slack notifications.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/hosted
```

## Usage

```ts
import { createHostedApp } from '@openbooking-sh/hosted';

const hosted = createHostedApp({
  baseUrl: 'https://app.example.com',
  sessionSecret: process.env.SESSION_SECRET!,
  // plus Postgres stores, mail, google, analytics, ops: see the docs
});
// hosted.app is a web-standard app; serve it anywhere
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
