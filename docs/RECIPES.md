# Recipes

Copy-paste starting points. Every snippet uses the published `@openbooking-sh/*` packages.

## 1. A booking backend in one file

```sh
npm install @openbooking-sh/server @openbooking-sh/provider-memory
```

```ts
// server.ts: run with `npx tsx server.ts`
import { createOpenBookingApp, listen } from '@openbooking-sh/server';
import { MemoryBookingProvider, type MemoryProviderConfig } from '@openbooking-sh/provider-memory';

const salon: MemoryProviderConfig = {
  name: 'Studio Nord',
  venues: [
    {
      venue: {
        id: 'studio-nord',
        name: 'Studio Nord',
        timezone: 'Europe/Oslo',
        currency: 'NOK',
        address: {
          street_address: 'Eksempelgata 12',
          postal_code: '0550',
          address_locality: 'Oslo',
          address_country: 'NO',
        },
      },
      currency: 'NOK',
      // Who or what gets booked. Tags let customers ask for someone by name.
      resources: [
        {
          id: 'maria',
          venue_id: 'studio-nord',
          kind: 'staff',
          name: 'Maria',
          capacity: { min: 1, max: 1 },
          tags: ['maria'],
        },
        {
          id: 'jonas',
          venue_id: 'studio-nord',
          kind: 'staff',
          name: 'Jonas',
          capacity: { min: 1, max: 1 },
          tags: ['jonas'],
        },
      ],
      offerings: [
        {
          id: 'haircut',
          venue_id: 'studio-nord',
          name: 'Haircut',
          duration_minutes: 45,
          price_per_person: { amount: 65000, currency: 'NOK' }, // minor units: 650.00 NOK
          resource_kinds: ['staff'],
          cancellation: {
            refundability: 'refundable',
            free_until_hours_before: 24,
            late_fee_per_person: 32500,
            no_show_fee_per_person: 32500,
          },
          deposit: null,
        },
      ],
      // Weekday 0 = Sunday … 6 = Saturday. Missing = closed.
      opening_hours: {
        2: [{ open: '09:00', close: '18:00' }],
        3: [{ open: '09:00', close: '18:00' }],
        4: [{ open: '09:00', close: '18:00' }],
        5: [{ open: '09:00', close: '18:00' }],
        6: [{ open: '10:00', close: '16:00' }],
      },
      slot_interval_minutes: 15,
      buffer_minutes: 10, // break between appointments with the same person
      min_lead_minutes: 60,
      max_days_ahead: 60,
    },
  ],
};

const { app } = createOpenBookingApp({
  provider: new MemoryBookingProvider(salon),
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',
  studio: { token: process.env.STUDIO_TOKEN }, // Studio is open without a token on localhost only
});
await listen(app, { port: 3000 });
```

You get:

- `/book`: the booking page;
- `/book/embed.js`: the website snippet;
- `/mcp`: for Claude, ChatGPT and other MCP clients;
- `/ucp` and `/.well-known/ucp`: UCP;
- `/.well-known/agent-card.json`: A2A;
- `/studio`: the dashboard.

## 2. Keep bookings in Postgres

```sh
npm install @openbooking-sh/postgres
```

```ts
import { connectPostgres, migrate, postgresStores } from '@openbooking-sh/postgres';

const db = connectPostgres(process.env.DATABASE_URL!);
await migrate(db); // creates and upgrades tables; safe on every start
const stores = postgresStores(db);

const { app } = createOpenBookingApp({
  provider: new MemoryBookingProvider(salon, { store: stores.bookings }),
  serviceOptions: { idempotencyStore: stores.idempotency },
  studio: { token: process.env.STUDIO_TOKEN, activity: stores.activity },
  baseUrl: process.env.BASE_URL!,
});
```

Holds are reserved under a per-resource lock, so two servers can never sell the same time.

## 3. Deploy to Vercel

Export the app as a Vercel Function and send every path to it:

```ts
// api/index.ts
const handle = (request: Request) => app.fetch(request);
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
```

```json
// vercel.json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api" }] }
```

Set `BASE_URL` to your public URL, plus `STUDIO_TOKEN` and `DATABASE_URL`.

## 4. Add booking to an existing website

One line, before `</body>`:

```html
<script src="https://your-booking-backend.example.com/book/embed.js" async></script>
```

What it does:

- adds a floating Book button and a booking popup;
- makes links to the booking page (and any element with `data-openbooking`) open the popup;
- adds schema.org data for search engines and AI;
- registers WebMCP booking tools for AI browsers.

Options on the tag: `data-label`, `data-color`, `data-position="left"`, `data-button="none"`,
`data-structured-data="off"`, `data-agents="off"`.

On hosted OpenBooking, the snippet is `https://app.openbooking.sh/b/<business>/embed.js`.

## 5. Connect an existing booking system

Implement `BookingProvider` from `@openbooking-sh/core`. The engine handles agent safety (consent,
idempotency, hold expiry, cancellation rules); you translate to your system:

```ts
import type { BookingProvider } from '@openbooking-sh/core';

export class MySystemProvider implements BookingProvider {
  readonly info = { name: 'My booking system' };
  async listVenues() {
    /* your locations */
  }
  async searchAvailability(query, ctx) {
    /* free slots with price and cancellation policy */
  }
  async createHold(req, ctx) {
    /* reserve atomically until req.expires_at */
  }
  async confirmHold(req, ctx) {
    /* turn the hold into a booking; re-check expiry */
  }
  async getBooking(id, ctx) {
    /* … */
  }
  async cancelBooking(req, ctx) {
    /* release a hold or cancel with req.fee / req.refund */
  }
}
```

The contract:

- every mutation is atomic;
- two overlapping holds must never both succeed (throw `BookingError('slot_unavailable')`);
- expired holds stop blocking inventory.

`@openbooking-sh/provider-memory` and `@openbooking-sh/provider-calcom` are complete examples.

## 6. Get webhooks when bookings change

Send `booking.held`, `booking.confirmed`, `booking.updated`, `booking.cancelled` and `booking.rescheduled` to your CRM,
SMS sender or own database. A reschedule sends one `booking.rescheduled` (the new booking in `data.booking`, the
moved one in `data.previous_booking`), not a confirmed plus a cancelled:

```ts
const { app, webhooks } = createOpenBookingApp({
  provider,
  baseUrl: process.env.BASE_URL!,
  webhooks: {
    endpoints: [{ url: 'https://crm.example.com/hooks', secret: process.env.WEBHOOK_SECRET! }],
  },
});
// On Vercel and other serverless hosts, let retries finish after the response:
// waitUntil(webhooks!.idle());
```

Each delivery is a JSON POST with an `openbooking-signature` header (`t=…,v1=…`, HMAC-SHA256)
and an `openbooking-event-id` header. Verify it on the receiving side with the raw body:

```ts
import { verifyWebhook } from '@openbooking-sh/core';

const body = await request.text();
if (!(await verifyWebhook(body, request.headers.get('openbooking-signature'), secret))) {
  return new Response('bad signature', { status: 401 });
}
const event = JSON.parse(body); // { id, type, created_at, data: { booking, actor } }
```

Failed deliveries are retried after 2 s, 15 s and 60 s. Delivery is at least once, so dedupe on
`event.id`. Retries (same idempotency key) and no-op cancels don't send events. Payloads include
customer details, so never point a webhook at an analytics or logging service. Without the server,
`createWebhooks()` returns a listener for `service.on()`.

## Rules for AI coding tools

If you're an AI assistant adding OpenBooking to a project:

- **Use the packages; don't reimplement booking logic.** Holds, idempotency and consent are subtle.
- **Prices are in minor units:** `65000` = 650.00 NOK.
- **Opening hours use weekday numbers,** 0 = Sunday.
- **Never call `confirm` without the end user's explicit yes** to time, price and cancellation
  terms (`user_confirmed: true`).
- **Every hold and confirm needs a fresh `idempotency_key`** (8+ characters); reuse it only to
  retry the same request.
- **Protect Studio with `STUDIO_TOKEN` anywhere but localhost.**
