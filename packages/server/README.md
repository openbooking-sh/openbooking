# @openbooking-sh/server

**One app for every agent protocol.** Mounts a `BookingProvider` on one web-standard app (Hono): MCP for Claude and ChatGPT, UCP, an A2A Agent Card, a public booking page with WebMCP, and OpenBooking Studio. Runs on Node, Vercel, Cloudflare, Deno and Bun.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/server
```

## Usage

```ts
import { createOpenBookingApp, listen } from '@openbooking-sh/server';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';

const { app } = createOpenBookingApp({
  provider: createDemoSalonProvider(), // or your own BookingProvider
  baseUrl: 'https://book.example.com',
});

await listen(app, { port: 3000 });
// MCP at /mcp · booking page at /book · Studio at /studio · UCP at /.well-known/ucp
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
