# OpenBooking

**Make any booking system bookable by AI agents through one integration.**

Restaurants, salons, clinics: implement one `BookingProvider` interface, and OpenBooking exposes
it to agents over **MCP**, **UCP** and **A2A**. It enforces the rules that make agent bookings
safe:

- holds that expire;
- idempotent retries that never double-book;
- explicit user confirmation;
- policy terms disclosed up front.

| Protocol                              | Status       | What you get                                                                                                                        |
| ------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **MCP** (Model Context Protocol)      | ✅ Supported | 5 agent-friendly tools over Streamable HTTP (2025 and 2026-07-28 eras) and stdio                                                    |
| **UCP** (Universal Commerce Protocol) | 🟡 Draft     | `/.well-known/ucp` profile plus `dev.ucp.lodging.booking` REST sessions, extended for time slots ([spec notes](docs/SPEC-NOTES.md)) |
| **A2A** (Agent2Agent)                 | ⚪ Stub      | v1.0 Agent Card at `/.well-known/agent-card.json`; task endpoint not implemented yet                                                |

## Install

```sh
npm install @openbooking-sh/server @openbooking-sh/core
```

```ts
import { createOpenBookingApp, listen } from '@openbooking-sh/server';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';

const { app } = createOpenBookingApp({
  provider: createDemoSalonProvider(), // or your own BookingProvider
  baseUrl: 'http://localhost:3000',
});
await listen(app, { port: 3000 });
// MCP at /mcp · booking page at /book · Studio at /studio · UCP at /.well-known/ucp
```

| Package                                                                                                                             | What it is                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`@openbooking-sh/core`](packages/core)                                                                                             | The engine and the `BookingProvider` interface                           |
| [`@openbooking-sh/server`](packages/server)                                                                                         | One app for MCP, UCP, A2A, booking page and Studio                       |
| [`@openbooking-sh/provider-memory`](packages/provider-memory)                                                                       | Configured provider (services, staff, hours, rules) on a pluggable store |
| [`@openbooking-sh/postgres`](packages/postgres)                                                                                     | Postgres storage for everything                                          |
| [`@openbooking-sh/booking-page`](packages/booking-page)                                                                             | Booking page, embed snippet and WebMCP                                   |
| [`@openbooking-sh/studio`](packages/studio)                                                                                         | Dashboard for the business                                               |
| [`@openbooking-sh/adapter-mcp`](packages/adapter-mcp), [`adapter-ucp`](packages/adapter-ucp), [`adapter-a2a`](packages/adapter-a2a) | The protocol adapters                                                    |
| [`@openbooking-sh/provider-calcom`](packages/provider-calcom)                                                                       | Cal.com connector (beta)                                                 |
| [`@openbooking-sh/notifications`](packages/notifications), [`google-calendar`](packages/google-calendar)                            | Emails with .ics, Google Calendar sync                                   |
| [`@openbooking-sh/hosted`](packages/hosted)                                                                                         | Multi-business hosting (what runs app.openbooking.sh)                    |

## 5-minute quickstart

Requires Node 22.12+ and pnpm. The published packages run on Node 20+. Run `corepack enable` or `npm i -g pnpm`.

```sh
git clone <this repo> openbooking && cd openbooking
pnpm install
pnpm dev
```

This starts **Studio Nord**, a fictional hair salon (in-memory) with three stylists, three services (haircut, beard trim, color & cut with a deposit), opening hours and a cancellation policy. Run `DEMO=restaurant pnpm dev` for the restaurant demo instead.

```
MCP (Streamable HTTP)  http://localhost:3000/mcp
UCP profile            http://localhost:3000/.well-known/ucp
UCP REST               http://localhost:3000/ucp/booking-sessions
A2A Agent Card         http://localhost:3000/.well-known/agent-card.json
Studio (dashboard)     http://localhost:3000/studio
```

**Try it with an agent.** Point any MCP client at `http://localhost:3000/mcp`. For example, run
`npx @modelcontextprotocol/inspector`. Then ask the agent to _"book me a haircut with Maria on Friday
afternoon"_.

For stdio clients, use `pnpm --dir examples/demo stdio` (config snippet in
[`examples/demo/src/stdio.ts`](examples/demo/src/stdio.ts)).

**Try it with curl (UCP REST).**

```sh
# 1. find a slot (EXTENSION: sh.openbooking.availability)
curl "localhost:3000/ucp/availability?date=2026-10-09&party_size=1&offering_id=haircut&time_from=15:00"

# 2. hold it (a UCP booking session); copy an offer id from step 1
curl -X POST localhost:3000/ucp/booking-sessions \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"stays":[{"id":"<offer id>"}],"booker":{"first_name":"Ada","last_name":"Lovelace","email":"ada@example.com"}}'

# 3. confirm, only with explicit user consent
curl -X POST localhost:3000/ucp/booking-sessions/<id>/complete \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"user_confirmed":true}'
```

## Keep bookings in Postgres

The demos are in-memory by default. Set `DATABASE_URL` and bookings, holds, idempotency records and Studio activity are stored in Postgres (tables are created on start):

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/openbooking pnpm dev
```

On Vercel, add a Postgres database from the Marketplace (Neon, Supabase…) and use its pooled connection string. In code:

```ts
import { connectPostgres, migrate, postgresStores } from '@openbooking-sh/postgres';

const db = connectPostgres(process.env.DATABASE_URL!);
await migrate(db);
const stores = postgresStores(db);

createOpenBookingApp({
  provider: createDemoSalonProvider({ store: stores.bookings }), // or new CalcomBookingProvider({ store: stores.calcom, ... })
  serviceOptions: { idempotencyStore: stores.idempotency },
  studio: { token: process.env.STUDIO_TOKEN, activity: stores.activity },
  baseUrl,
});
```

Holds are reserved under a per-resource lock, so two servers can never hand out the same time.

## OpenBooking Studio

The booking system for the people running the business, at `/studio`:

- **Calendar:** a day view with a column per staff member or table, and the day's bookings and takings at a glance.
- **New booking:** staff book phone calls and walk-ins. It finds free times, takes customer details, and records a deposit collected at the desk.
- **Bookings:** filter by status. Open a booking for guest details, deposit, cancellation terms and history. Cancel or release a hold.
- **Customers:** everyone who booked, with visits, spend, next visit and the channel they first came through.
- **Services & staff:** what customers and AI assistants can book.
- **Insights and agent log:** bookings per channel (Claude, ChatGPT, Studio…) and every agent call with its result.

In local dev (`baseUrl` on localhost) the Studio opens without a login. Anywhere else, set a token: `createOpenBookingApp({ ..., studio: { token: process.env.STUDIO_TOKEN } })`. Without a token, the Studio API stays locked. Agent names are self-reported by clients, so use them for analytics only, never for access control.

## Hosted: many businesses, one deployment

```sh
pnpm dev:hosted
```

Businesses sign up at `/signup` and set up services, staff, hours and cancellation rules in Studio.
Each gets a booking page at `/b/<id>`. Every listed business is bookable through one MCP app at
`/mcp` (`find_business` → booking tools), with optional Google Calendar sync and confirmation
emails. See [docs/HOSTED.md](docs/HOSTED.md).

## The MCP tools

| Tool                  | Does                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `search_availability` | Slots for a date and party size, with price, deposit and cancellation policy. Nothing is reserved.                       |
| `hold_slot`           | Reserves a slot until `expires_at`. Returns `booking_id` and the terms to show the user.                                 |
| `confirm_booking`     | Confirms a hold. Requires `user_confirmed: true`, customer details, and a `payment_token` if a deposit is due.           |
| `get_booking`         | Current status and details.                                                                                              |
| `cancel_booking`      | Releases a hold, or cancels a confirmed booking. A confirmed booking needs `user_confirmed`; the fee follows the policy. |

**Design rules:**

- Every mutating tool takes an `idempotency_key`.
- Every error is `{ code, message, suggested_next_action }`.
- Every booking response includes `next_step`.

## Connect Cal.com (beta)

Already on [Cal.com](https://cal.com) or self-hosted Cal.diy? Your event types become bookable by AI agents with no code:

```sh
CAL_API_KEY=cal_live_... VENUE_NAME="Studio Nord" VENUE_TIMEZONE=Europe/Oslo pnpm dev
# optional: CAL_EVENT_TYPE_IDS="123,456"  CAL_BASE_URL=https://cal.example.com  VENUE_CURRENCY=NOK
```

Or in code:

```ts
import { CalcomBookingProvider } from '@openbooking-sh/provider-calcom';

const provider = new CalcomBookingProvider({
  apiKey: process.env.CAL_API_KEY!,
  venue: { id: 'studio-nord', name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
});
```

How it maps:

- Each event type becomes an offering.
- A hold is a Cal.com slot reservation for the hold time.
- Confirm creates the Cal.com booking. Cal.com requires an email, so agents are asked for one.
- Cancel cancels it in Cal.com.
- Cancellations made in Cal.com show up in OpenBooking.

Limits in this beta:

- One person per appointment.
- Paid event types aren't charged through OpenBooking.
- Hold and booking records are in memory until a durable store is added.
- Tested against the documented API v2 shapes, not yet end to end on a live account.

## Implementing `BookingProvider`

You own inventory and persistence. OpenBooking owns validation, idempotency, hold expiry, consent and cancellation rules.

```ts
import { BookingError, type BookingProvider } from '@openbooking-sh/core';
import { createOpenBookingApp, listen } from '@openbooking-sh/server';

class MySalonProvider implements BookingProvider {
  info = { name: 'Studio Nord', description: 'Hair salon in Bergen' };

  async listVenues() {
    return [{ id: 'nord', name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' }];
  }

  async searchAvailability(query, ctx) {
    // query: { venue_id, date, party_size, time_from?, time_to?, offering_id?, tags?, limit }
    // Return Slot[]: each with an opaque slot_id, start/end (ISO with offset), price,
    // deposit (or null) and a cancellation_policy computed for that slot.
  }

  async createHold({ slot_id, expires_at, customer, notes }, ctx) {
    // ATOMICALLY reserve the slot until expires_at (transaction / unique constraint).
    // If it's gone: throw new BookingError('slot_unavailable', 'Just taken.');
    // Return the Booking with status 'held'.
  }

  async confirmHold({ booking_id, customer, payment_token }, ctx) {
    // Re-check expiry atomically, charge the deposit if any, mark confirmed, return the Booking.
  }

  async getBooking(id, ctx) {
    /* … */
  }

  async cancelBooking({ booking_id, reason, fee, refund }, ctx) {
    // Release the hold, or cancel and record the fee/refund the engine computed.
  }

  // optional: updateBooking({ booking_id, customer?, notes? }, ctx)
}

const { app } = createOpenBookingApp({
  provider: new MySalonProvider(),
  baseUrl: 'https://book.studionord.example',
});
await listen(app, { port: 3000 });
```

The contract is documented in
[`packages/core/src/provider.ts`](packages/core/src/provider.ts).
[`provider-memory`](packages/provider-memory/src/provider.ts) is a complete reference
implementation. The four rules:

1. Mutations are atomic.
2. Overlapping holds never both succeed.
3. Expired holds stop blocking inventory.
4. Business failures throw `BookingError` with a specific code.

## Repository layout

```
packages/
  core/             Domain model, BookingProvider, BookingService (agent-safety rules)
  provider-memory/  Configured provider (catalog + slot rules) + demo salon and restaurant
  postgres/         Postgres storage: bookings, idempotency, Studio activity, Cal.com records
  adapter-mcp/      MCP tools (Streamable HTTP + stdio)
  adapter-ucp/      UCP discovery + booking sessions (draft)
  adapter-a2a/      A2A Agent Card (stub)
  studio/           OpenBooking Studio dashboard (/studio), incl. business settings
  booking-page/     Public booking page: pre-filled links, JSON-LD, WebMCP, manage links
  notifications/    Confirmation/cancellation emails with .ics invites
  google-calendar/  Google Calendar sync (busy times, bookings as events)
  server/           One Hono app mounting everything
  hosted/           Many businesses on one deployment: sign-up, settings, the OpenBooking MCP app
examples/demo/
bench/              Agent-success benchmark (tasks + runner)
docs/ARCHITECTURE.md, docs/SPEC-NOTES.md, docs/HOSTED.md
```

## Development

```sh
pnpm dev          # demo server with watch
pnpm test         # vitest (unit + MCP end-to-end + bench smoke test)
pnpm typecheck
pnpm lint
pnpm build        # tsup → dist/ per package
pnpm bench        # run the agent benchmark (scripted baseline)
pnpm changeset    # describe a change for release
```

The benchmark ([`bench/`](bench/README.md)) runs booking tasks against isolated servers. It measures:

- completion rate;
- double bookings;
- expired-hold errors.

LLM drivers plug into a stub interface.

## License

[Apache-2.0](LICENSE)
