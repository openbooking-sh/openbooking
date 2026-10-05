# Architecture

```
            AI agents / platforms
   ┌──────────────┬───────────────┬──────────────┐
   │ MCP client   │ UCP platform  │ A2A client   │
   └──────┬───────┴───────┬───────┴──────┬───────┘
          │ /mcp          │ /ucp/*       │ /a2a  (+ /.well-known/ucp, /.well-known/agent-card.json)
   ┌──────▼───────────────▼──────────────▼───────┐
   │ @openbooking-sh/server   (one Hono app)        │
   │  adapter-mcp   adapter-ucp   adapter-a2a    │  ← thin protocol translation
   └──────────────────────┬──────────────────────┘
                          │
   ┌──────────────────────▼──────────────────────┐
   │ @openbooking-sh/core  BookingService           │  ← agent-safety lives here, once
   │  validation · idempotency · hold TTL ·      │
   │  explicit consent · cancellation rules      │
   └──────────────────────┬──────────────────────┘
                          │ BookingProvider (the ONE interface you implement)
   ┌──────────────────────▼──────────────────────┐
   │ provider-memory | your POS / PMS / calendar │  ← inventory + persistence
   └─────────────────────────────────────────────┘
```

## Packages

| Package                           | Responsibility                                                                                                      | Depends on                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@openbooking-sh/core`            | Domain model (zod), `BookingProvider`, `BookingService`, errors, idempotency, cancellation rules, time-zone helpers | `zod`                                                                   |
| `@openbooking-sh/provider-memory` | Configured provider (catalog + slot rules) on a pluggable `BookingRecordStore`; demo salon and restaurant           | core                                                                    |
| `@openbooking-sh/postgres`        | Postgres stores: bookings/holds, idempotency, Studio activity, Cal.com records; `migrate()`                         | core, provider-memory, studio, `pg`                                     |
| `@openbooking-sh/adapter-mcp`     | Five MCP tools, Streamable HTTP handler, stdio                                                                      | core, `@modelcontextprotocol/server`                                    |
| `@openbooking-sh/adapter-ucp`     | UCP profile, booking-session REST, availability extension                                                           | core, `hono`                                                            |
| `@openbooking-sh/adapter-a2a`     | Agent Card builder plus a stub endpoint                                                                             | core                                                                    |
| `@openbooking-sh/server`          | Mounts everything on one Hono app; `listen()` for Node                                                              | all adapters, `hono`, `@hono/node-server`, `@modelcontextprotocol/hono` |
| `examples/demo`                   | `pnpm dev`                                                                                                          | server, provider-memory                                                 |
| `@openbooking-sh/booking-page`    | Public booking page and its JSON API, manage links, JSON-LD, WebMCP                                                 | core, `hono`                                                            |
| `@openbooking-sh/notifications`   | Booking emails with .ics invites (`Mailer`: Resend, console, memory)                                                | core                                                                    |
| `@openbooking-sh/google-calendar` | Google OAuth, busy-time source, bookings → events                                                                   | core, provider-memory                                                   |
| `@openbooking-sh/hosted`          | Many businesses: accounts, settings → catalog, per-business runtime, the OpenBooking MCP app (`find_business`)      | all of the above                                                        |
| `bench`                           | Agent-success benchmark                                                                                             | server, provider-memory, MCP client                                     |

## Who owns what

The split matters. Every protocol must behave identically, and booking-system vendors should only
have to think about inventory.

**The provider** (`BookingProvider`) owns:

- what exists: venues, resources, offerings, opening hours, prices, policies;
- what is free;
- atomic reservation.

Its contract:

1. Every mutating method is atomic: it fully succeeds, or throws without side effects.
2. `createHold` reserves capacity **exclusively** until `expires_at`. Two overlapping holds for the same capacity must never both succeed.
3. Expired holds stop blocking inventory. Report them as `expired`.
4. Business failures throw `BookingError` with a specific code. Anything else is reported to agents as a retryable `provider_error`.

**The `BookingService`** owns the agent-safety rules:

- **Validation.** Zod at the boundary. Failures become a `validation_error` that lists every bad field.
- **Idempotency.**
  - Every mutating call needs an `idempotency_key`. Same key and same request replays the result; same key and a different request is `idempotency_conflict`.
  - Concurrent calls with the same key share one execution. The in-flight entry is registered synchronously, before any `await`.
  - Only successes are stored, because failed calls changed nothing.
  - Replays return the **current** state of the booking.
- **Hold TTL.** The engine computes `expires_at`; every hold response carries it. Reads present a past-expiry hold as `expired` even if the provider hasn't swept it yet.
- **Consent.** `confirm` requires `user_confirmed === true`, as does cancelling a _confirmed_ booking. Releasing a hold doesn't need it.
- **Prerequisites.**
  - Customer details (name plus email or phone) are required before confirmation.
  - A `payment_token` is required when a deposit is due at confirmation.
- **Cancellation rules.** The pure function `evaluateCancellation()`:
  - free before `free_cancellation_until`;
  - the late fee after that (for `non_refundable`, the paid deposit is retained);
  - not cancellable online once the booking has started.

  The provider just records the computed fee and refund.

- **State idempotency.** Confirming an already-confirmed booking returns it, even with a fresh key. Cancelling an already-cancelled booking is a no-op. An agent that loses a response and retries with a new key therefore still can't double-book or double-charge.
- **Events.** `onEvent` fires after every operation (operation, ok, booking id, status, error code, replayed). The demo logs it; the bench counts with it.

**Adapters** only translate. They never call the provider directly.

## Lifecycle

```
search_availability ──► slots (with price, deposit, cancellation policy; not reserved)
        │
hold_slot ─────────────► booking { status: held, expires_at }      ── TTL passes ──► expired
        │                       │
        │                  update (customer/notes)
        │                       │
confirm_booking(user_confirmed=true) ──► confirmed { confirmation_code }
        │
cancel_booking ────────► held: released (no fee)
                         confirmed: needs user_confirmed; fee/refund per policy ──► cancelled
```

The UCP status mapping is in [SPEC-NOTES §1.5](./SPEC-NOTES.md#15-status-mapping).

## Agent-friendly design choices

- **Few tools, flat inputs.** Five tools, and `party_size` is an integer. Each tool description says what it does and does **not** do, e.g. "hold does NOT confirm".
- **Responses tell the agent what to do.** Every booking response includes `next_step`, and every error includes `suggested_next_action`. Holds carry both `expires_at` and `expires_in_seconds`.
- **Policy terms up front.** Search results and holds carry the cancellation policy (human-readable `description` plus structured fields) and the deposit terms _before_ confirmation.
- **Opaque slot ids.** A `slot_id` encodes everything needed to hold it, so the agent doesn't re-send dates and times and can't get them wrong.

## Scaling beyond the demo

- **Postgres.** `@openbooking-sh/postgres` makes everything durable and safe across instances. `PostgresBookingStore` reserves under a transaction-scoped advisory lock per venue resource (check overlap, then insert), so overlapping holds can never both commit. Updates take the same lock, and a confirm that turns blocking re-checks for overlaps: a late confirm whose hold lapsed and was re-booked fails with `hold_expired` instead of double-booking. Expiry is applied on read, so no sweeper job is needed. Run `migrate(db)` on start (idempotent, lock-serialised).
- **Idempotency store.** `PostgresIdempotencyStore` (or your own `IdempotencyStore` on Redis/SQL) as `serviceOptions.idempotencyStore`. The in-flight dedupe is per process. Across instances, two simultaneous first calls with one key can both run; inventory stays safe through the atomic store, and the later record wins.
- **Clock.** Inject a `Clock` for tests and simulations (`ManualClock`, the bench's `OffsetClock`).
- **MCP.** `createMcpHandler` is stateless, so any instance can serve any request. Set `allowedHosts` to your public hostnames.

## Development notes

- **Source-first packages.** Each package's `exports` has a custom `@openbooking/source` condition that points at `src/index.ts`. `tsc` (`customConditions`), vitest (`resolve.conditions`) and `tsx --conditions` all use it, so `pnpm dev`, `pnpm test` and `pnpm typecheck` need no build. Published consumers get `dist/`.
- **Build.** `tsup` builds ESM plus `.d.ts` per package.
- **Tests.**
  - Unit tests per package live in `packages/*/test`.
  - The end-to-end MCP test in `packages/server/test` drives the full Hono app with a real MCP client, in-process, on both protocol eras.
  - The bench smoke test runs every task with the scripted driver.
