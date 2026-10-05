# Contributing to OpenBooking

Thanks for helping make booking work for AI agents. Bug reports, docs fixes, new providers and
protocol work are all welcome.

## Setup

You need Node 22+ and pnpm (the repo pins the version; `corepack enable` picks it up).

```sh
git clone https://github.com/openbooking-sh/openbooking.git
cd openbooking
pnpm install
pnpm dev          # demo salon with MCP, booking page and Studio on http://localhost:3000
pnpm dev:hosted   # hosted OpenBooking (sign-up, setup, many businesses), in memory
```

Packages resolve to their TypeScript sources in development, so nothing needs building first.

## Checks

Run these before opening a pull request; CI runs the same on Node 22 and 24:

```sh
pnpm format:check   # or `pnpm format` to fix
pnpm lint
pnpm typecheck
pnpm test
```

The Postgres tests use embedded PGlite by default. To run them against a real server:

```sh
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres pnpm vitest run packages/postgres
```

## Where things live

See the [package map](README.md#install) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In
short: `packages/core` is the engine and the `BookingProvider` interface; `adapter-*` are the agent
protocols; `server` mounts everything; `hosted` is the multi-business app behind
app.openbooking.sh.

## Pull requests

- Keep each PR to one change, with tests. Bugs get a test that fails without the fix.
- Booking logic must stay agent-safe:
  - mutations are atomic;
  - retries with the same idempotency key never book twice;
  - nothing is confirmed without `user_confirmed`;
  - terms are shown before booking.
- Never send customer names, emails or phone numbers to analytics, logs or notifications.
- If your change affects a published package, add a changeset: `pnpm changeset`. Pick the
  packages and the bump (patch for fixes, minor for features while we're on 0.x) and describe the
  change for users.

## Releases

Maintainers merge the "Release: version packages" PR that the Release workflow opens. The
workflow then publishes to npm with trusted publishing and provenance. See
[`.github/workflows/release.yml`](.github/workflows/release.yml).

## License

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 license](LICENSE).
