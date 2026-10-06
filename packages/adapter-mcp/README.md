# @openbooking-sh/adapter-mcp

**MCP server for booking.** Six booking tools for any MCP client (Claude, ChatGPT, Cursor and more): `get_business_info`, `search_availability`, `hold_slot`, `confirm_booking`, `get_booking` and `cancel_booking`. Served over Streamable HTTP or stdio.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/adapter-mcp
```

## Usage

```ts
import { createMcpHttpHandler } from '@openbooking-sh/adapter-mcp';

const mcp = createMcpHttpHandler({ service }); // service: a BookingService from @openbooking-sh/core
// Web-standard handler: return mcp.fetch(request) from any route, e.g. /mcp
```

Most apps use this through `@openbooking-sh/server`, which mounts it with host and origin checks.

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
