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

Test it with `@openbooking-sh/conformance` (`npm install -D @openbooking-sh/conformance vitest`):

```ts
import { describeProviderConformance } from '@openbooking-sh/conformance/vitest';

describeProviderConformance('MySystemProvider', {
  create: () => new MySystemProvider(testConfig), // a fresh, empty provider per test
  now: new Date('2030-06-03T08:00:00Z'), // before the date you search
  query: { date: '2030-06-04', party_size: { total: 1 } }, // must return open slots
});
```

The suite never assumes one place per slot: it books a slot until the provider answers
`slot_unavailable`, then checks that parallel holds cannot go past that point. `query` must return
an open slot, and another slot at a different time once the first is full.

A provider that can seat a party at tables pushed together (one booking, several tables) opts in to
more checks with `combinedTables`. Providers without joined tables leave it out and are not
affected.

```ts
describeProviderConformance('MySystemProvider', {
  // …create, now, query as above
  combinedTables: {
    // A party too big for any one table: every slot is a joined one, and a second joined slot at
    // another time is open once the first is full.
    query: { date: '2030-06-04', party_size: { total: 6 } },
  },
});
```

The slots must name each table by id (`resource.id` and `additional_resources[].id`). The suite then
checks that a joined booking takes every one of its tables together, that cancelling it, letting its
hold expire or moving it frees every one (and no more), that a confirmed booking keeps all of them,
and that no table ends up in two bookings that overlap in time, however many callers ask at once.

## 6. Get webhooks when bookings change

Send `booking.held`, `booking.confirmed`, `booking.updated`, `booking.cancelled` and
`booking.expired` to your CRM, SMS sender or own database:

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

Failed deliveries are retried after 2 s, 15 s and 60 s. Events reach each endpoint in the order they
happened, so a failing endpoint holds back its later events until the earlier one succeeds or gives
up. Delivery is at least once, so dedupe on
`event.id`. Retries (same idempotency key) and no-op cancels don't send events. Payloads include
customer details, so never point a webhook at an analytics or logging service. Without the server,
`createWebhooks()` returns a listener for `service.on()`.

## 7. Take deposits with Stripe

A slot can require a deposit at confirmation. Give the service a payment provider and the engine
handles the rest:

```ts
import { StripePayments } from '@openbooking-sh/payments-stripe';

const service = new BookingService({
  provider,
  payments: new StripePayments({
    secretKey: process.env.STRIPE_SECRET_KEY!, // sk_test_… while you try it
    successUrl: 'https://example.com/booked',
    cancelUrl: 'https://example.com/book',
  }),
});
```

1. `confirm_booking` without a token fails with `payment_required`. The error carries a
   `payment_url` (a Stripe Checkout page) and a `payment_token`. The agent gives the user the link.
2. After the user pays, `confirm_booking` again with that `payment_token`. The engine asks Stripe
   whether the session was paid, for this booking, for the deposit amount. Only then is the booking
   confirmed, and the payment reference is kept on it. Tokens an agent makes up are refused.
3. Cancelling refunds what the cancellation terms say (the whole deposit before the free-cancellation
   deadline, the deposit minus the late fee after it). If Stripe is down, the booking is still
   cancelled and `cancel_booking` replies `refund_failed`; calling it again retries, and the
   idempotency key means the customer is never refunded twice.
4. If the customer pays after the hold expired, the payment is refunded and the agent gets
   `hold_expired`.

Staff taking a deposit in cash in Studio still works: Studio records it as collected, with no
Stripe involved. For a connected account (Stripe Connect) pass `stripeAccount`.

Not built yet: per-business Stripe accounts and the payment page in the hosted booking page and
Studio. For now `payments` is for self-hosted setups.

## 8. Restaurants: table time, shifts and pacing

All of this is optional config on the provider; a config without it behaves exactly as before.

```ts
const bistro: VenueConfig = {
  // …venue, resources, opening_hours as usual
  offerings: [
    {
      // …
      duration_minutes: 90, // the default, also what listings show
      // The entry with the largest min_party_size that fits wins: 2 guests 90 min, 6 guests 2.5 h.
      duration_by_party: [
        { min_party_size: 1, duration_minutes: 90 },
        { min_party_size: 6, duration_minutes: 150 },
      ],
    },
  ],
  // Lunch and dinner. Starts are only offered inside a period (and opening hours).
  service_periods: [
    { name: 'Lunch', open: '11:30', close: '14:00', seatings: ['12:00', '13:15'] },
    {
      name: 'Dinner',
      open: '17:00',
      close: '22:00',
      max_online_guests: 60, // the rest is held for walk-ins and phone bookings
      max_guests_per_interval: 12, // overrides the venue pacing for this period
    },
  ],
  // At most 16 guests may arrive in the same 15 minutes, across all tables.
  pacing: { max_guests_per_interval: 16, interval_minutes: 15 },
};
```

- The table is blocked for the party's table time plus `buffer_minutes`, in search, holds and rescheduling.
- `seatings` are fixed start times (`HH:mm`) instead of every `slot_interval_minutes`. A period without them uses the grid. If a venue lists service periods, starts outside them are not offered.
- Pacing and `max_online_guests` count guests of held and confirmed bookings by their start time. Expired holds stop counting. Search never offers a start that a hold would then refuse, and the limit is checked atomically with the reservation (also across server instances and with the Postgres store), so a race cannot exceed it.
- When a limit is hit the agent gets `slot_unavailable` with a `suggested_next_action`: offer an earlier or later time, or (for the walk-in reserve) another date or the venue's phone number.
- `max_online_guests` is a number of guests per period. Not built: a share (percent), and a limit per table size.
- Hosted businesses store the simpler settings shape and do not use these fields yet.

### Joining tables for larger parties

Two 4-tops for a party of 8: list which tables may be pushed together and what party sizes the pair seats. Optional; without `table_combinations` one booking is one table, as before.

```ts
const bistro: VenueConfig = {
  // …
  table_combinations: [
    { resource_ids: ['t6', 't7'], min_party_size: 5, max_party_size: 8 },
    // Optional: more turnover for moving the tables back, and your own label for guests.
    {
      resource_ids: ['t8', 't9'],
      min_party_size: 5,
      max_party_size: 8,
      extra_buffer_minutes: 10,
      label: 'The window pair',
    },
  ],
};
```

- **Single table first.** A party gets the smallest single table that fits, as always. Joined tables are offered only when no single table that fits is free at that time. Search and holds use the same order, so search never offers a slot a hold would refuse.
- **Which pair.** Of the free combinations, the one that wastes the fewest seats wins, then the one with fewer tables, then the one whose biggest table is smaller (so large tables stay free). Equal choices keep the order in the config.
- **One booking, every table.** The booking occupies all its tables for the whole table time plus buffer (plus `extra_buffer_minutes`). The memory store and the Postgres store claim all of them or none, under one lock per table taken in a fixed order, so a race cannot put a table in two bookings. Cancelling, an expired hold and rescheduling free or move all of them. Postgres needs migration 7 (`migrate(db)` applies it).
- **What agents see.** `slot.resource` is the first table, with the label "Tables T6 and T7 together" (or your `label`); `slot.additional_resources` lists the others. The MCP `next_step` tells the agent to say the tables are joined.
- **Config is checked at startup:** unknown table ids, fewer than two tables, mixed kinds, a kind no offering uses, `max_party_size` above what the tables hold, the same tables listed twice for overlapping party sizes.
- **Studio** shows a joined booking on the calendar column of each table; counts and lists still count it once.
- **Demo restaurant.** `createDemoRestaurantProvider()` (and `pnpm dev`) uses all of the above, as a small bistro: tables 6 and 7 (two 4-tops) join for parties of 5 to 8 when no single table is free; lunch Tue–Sat has two seatings (12:00 and 13:15); dinner starts on the half hour; Sunday supper takes at most 24 guests online; at most 20 guests may arrive in the same 15 minutes; dinner table time is 90 minutes, 2 hours from 5 guests and 2.5 hours from 7. The benchmark and the tests run against it.
- Not built: joining three or more tables by chaining (list the triple as its own combination), tables that may only be joined at certain times, and joined tables in hosted businesses (they store the simpler settings shape).

## 9. Anti-scalping: limits, name-bound bookings and broker flags

Real assistants act for one consenting person; bots that hoard slots to resell them don't. All of this is optional (`serviceOptions.guard`). Without it nothing changes.

```ts
const ob = createOpenBookingApp({
  provider,
  baseUrl,
  serviceOptions: {
    guard: {
      salt: process.env.GUARD_SALT, // keeps the lookup keys private; keep it stable
      guest: { maxActive: 4, maxPerDay: 2 }, // upcoming bookings per guest and venue
      agent: { maxHolds: 6, maxActive: 40 }, // per assistant, see below
      nonTransferable: true,
      // flags: { contact_many_names: { count: 3, window_hours: 720 } },  // tune or `false`
    },
  },
});
// Several instances: guard: { store: postgresStores(db).guard, ... } (needs migration 8).
```

- **Per guest.** A guest is a normalised email or phone number (`A.Da+x@gmail.com` and `ada@gmail.com` are one guest; so are `+47 123 45 678` and `+4712345678`; either one matches). Held and confirmed bookings that have not ended count; expired holds and cancelled bookings do not. Checked when a hold names the guest and again at confirm, before any deposit is taken.
- **Per agent.** Open holds and upcoming bookings per agent identity. Without more, that identity is the client name an MCP, UCP, USP or A2A caller reports (`mcp:claude-ai`). It is self-reported and shared by every user of that assistant, so keep these limits generous; callers that name no client, the booking page and the API are not limited this way. Return a better id from `guard.identifyAgent(actor)` (an API key id, or a verified agent id once Web Bot Auth, OPE-57, lands) and the same limits and flags key on it.
- **Staff are exempt.** Studio actions (a manual booking, a transfer) are never limited.
- **Atomic.** The check and the write are one step in the guard ledger (`MemoryGuardStore`, or `PostgresGuardStore` shared by all instances), so concurrent holds cannot all slip under a limit. The hold is created first and handed back at once if the ledger refuses it. A reschedule updates the ledger but does not re-check the per-day limit (the new time is only known after the move).
- **What a refusal says.** `booking_limit_reached`, not retryable. The message and `suggested_next_action` say the venue limits online bookings and to contact the venue; they never say the number, so a bot learns nothing about how to spread out.
- **Name-bound bookings.** With `nonTransferable`, once a hold or booking names a guest only Studio can put another name on it: `confirm_booking` or `update_booking` with a different name is refused with `not_transferable` (a different spelling of the same name, or new contact details, is fine). Search results, holds and confirmations add one sentence to the cancellation terms: "This booking is in the guest's name and cannot be transferred to anyone else."
- **Flags, never bans.** When signals add up, the booking still goes through but is flagged for the venue: `agent_many_names` (10 names in 24 hours from one agent), `contact_many_names` (3 names in 30 days on one email or phone), `agent_cancel_churn` (10 confirmed bookings cancelled in 24 hours by one agent), `contact_cancel_churn` (3 in 7 days by one contact). Each rule's `{ count, window_hours }` can be changed, or set to `false`. Flags are never on the `Booking` and never in an MCP, UCP, USP, A2A or booking-page response; staff get them from `service.riskFlags(ids)`, and Studio's `/api/bookings` returns `risk_flags` on flagged bookings. Not built: a rule for peak slots in particular, and showing flags in the Studio UI.
- **What the ledger stores.** Hashed keys (HMAC with your salt) for the contact details and name, the client id, and times. No names, emails or phone numbers. Entries of bookings that ended 30 days ago are removed by `service.sweepExpired()`. Bookings made before you turn the guard on are not counted.

## 10. Waitlist: offer a freed slot with a hold

"Tell me if something opens up." A customer joins for a day (and optionally a service and a time window) that is full. When a booking is cancelled or a hold lapses, the first person waiting whose request now has something bookable gets a hold on it for a short while and an email. Nothing is booked for them: they confirm it like any hold, with `user_confirmed`.

```ts
import { BookingService, Waitlist } from '@openbooking-sh/core';
import { attachWaitlistNotifications } from '@openbooking-sh/notifications';
import { createOpenBookingApp } from '@openbooking-sh/server';

const service = new BookingService({ provider });
const waitlist = new Waitlist({
  service,
  offerTtlSeconds: 15 * 60, // how long a freed slot is held for the person offered it
  // store: postgresStores(db).waitlist,   // with more than one instance (needs migration 8)
});
attachWaitlistNotifications({
  waitlist,
  mailer,
  config: { from: 'Bistro <bookings@example.com>' },
  acceptUrl: (b) => `https://example.com/book/confirm/${b.booking_id}`, // the booking page's confirm link
});
createOpenBookingApp({ service, waitlist, baseUrl: 'https://example.com' }); // adds the MCP tools
setInterval(() => void waitlist.sweep(), 60_000); // or from a cron
```

- **Tools** (only when a waitlist is passed): `join_waitlist`, `check_waitlist`, `leave_waitlist`. Joining needs `user_confirmed: true` (the customer agreed to be emailed and to have a slot held for them; that is stored as consent evidence on the entry) and an email address, because that is where the offer goes. It is refused with `invalid_state` when something is bookable for the request, and the error lists the slots to hold instead. A retry with the same `idempotency_key` returns the same entry.
- **Order.** First come, first served per venue and day. An entry only gets a slot that fits its service, party size and time window, found by an ordinary availability search, so a freed 19:00 table does not go to someone who asked for 21:00. Entries that do not fit are skipped and keep their place.
- **One offer per slot, one slot per entry.** The offer is a real hold, so the provider's atomic reservation decides who gets a slot. Moving an entry from waiting to offered is an atomic compare-and-set in the `WaitlistStore` (memory, or Postgres with a row lock), so two cancellations at once, or two server instances handling the same freed slot, cannot offer a slot twice or give an entry two. The memory store and the Postgres store run the same contract tests.
- **Accepting is the normal confirm.** The offer carries a `booking_id`; the customer's agent (`check_waitlist` shows it) or the booking page's confirm link confirms it, with `user_confirmed`. Confirming marks the entry accepted. Releasing the hold or `leave_waitlist` marks it declined, and a hold that runs out marks it expired; either way the slot passes to the next entry.
- **Lapses are noticed like expiries are.** Offers pass on when something notices the hold lapsed (any read of the booking, `service.sweepExpired()`). `waitlist.sweep()` does that, retires entries whose day has passed, and deletes finished entries after `retentionDays` (30 by default). Run it on a timer or cron; it is safe from every instance.
- **Customer data.** Entries hold a name and email or phone. `waitlist.exportCustomer(match)` and `waitlist.eraseCustomer(match)` cover them (erasing releases a slot held for that customer first), and `store.deleteVenue(id)` removes a business's entries. Offer emails respect unsubscribes (`isSuppressed`): an unsubscribed customer's hold simply lapses. Waitlist events (`waitlist.on`) carry the customer, so send them to no logs or analytics.
- **Limits.** One email address or phone number may have 5 open entries per venue (`maxActivePerCustomer`).
- Not built: a Studio list and walk-ins (the store and `offerFreed(booking)` are the base for it), offers when a booking is moved with `reschedule`, preferring a staff member or table feature, SMS, and hosted businesses (the hosted app does not create a waitlist yet, so Studio's customer erasure there does not cover waitlist entries until it does).

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
