# Working on OpenBooking

Open-source TypeScript booking backend for the agent era: makes any business or booking platform
bookable by AI assistants over MCP, WebMCP and UCP (draft), with agent safety built in:

- holds that expire;
- idempotent retries that never double-book;
- explicit consent (`user_confirmed`);
- terms shown before booking.

Published on npm as `@openbooking-sh/*` and `create-openbooking`.

## Layout

pnpm 12 workspace, Node 22 and 24, strict TypeScript, ESM.

- `packages/core`: domain model (zod 4), the `BookingProvider` interface, and `BookingService` (the
  agent-safety engine).
- `packages/adapter-mcp|adapter-ucp|adapter-a2a`: protocols. `server` mounts everything on one
  Hono app.
- `packages/provider-memory`: the configured booking system (catalog, slot rules) on a pluggable
  store.
- `packages/postgres`: durable stores.
- `packages/booking-page`: booking page, embed snippet and WebMCP.
- `packages/studio`: the business dashboard.
- `packages/hosted`: multi-business hosting (app.openbooking.sh).
- `packages/notifications`, `google-calendar`, `provider-calcom`: integrations.
- `packages/create-openbooking`: the scaffold CLI and its `template/`.
- `api/index.ts`: the Vercel entry.
- `examples/demo`: `pnpm dev` and `pnpm dev:hosted`.
- `bench/`: the agent benchmark.
- Docs live in `docs/` (ARCHITECTURE, HOSTED, RECIPES, SPEC-NOTES). `llms.txt` and `llms-full.txt`
  are generated.

In development, packages resolve to `src` through the export condition `@openbooking/source`
(tsconfig, vitest, `tsx --conditions`). Nothing needs building to run dev or tests.

## Commands

```sh
pnpm install
pnpm dev                 # demo salon: booking page, Studio, MCP on :3000
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm build && node scripts/check-deps.mjs   # load-time imports must be declared deps
node scripts/smoke-create.mjs               # scaffold with create-openbooking, install packed packages, boot, book
pnpm docs                # regenerate package READMEs and llms files
```

Postgres tests use PGlite. Set `TEST_DATABASE_URL` to run them against a real server.

## Workflow

- **`main` is protected.** Branch, open a PR, and merge only with green CI: `check (22)`,
  `check (24)`, `postgres`, `scaffold`. Never push to `main`.
- **Changesets:** add `.changeset/*.md` for any change to a published package (patch for fixes,
  minor for features while on 0.x).
- **Releases:** merging to `main` makes the Release workflow open "Release: version packages".
  Merging that PR stages the versions on npm (trusted publishing, provenance), and a maintainer
  approves them on npmjs.com.
- **Never run `npm publish` yourself.**
- **Commits:** conventional style (`feat(scope): …`, `fix: …`), explaining _why_ in the body.

## Conventions

- Match the surrounding code:
  - zod 4 schemas;
  - Hono with web-standard `fetch` handlers;
  - comments that explain why, not what;
  - small focused modules.
- **Booking logic must stay agent-safe:**
  - provider mutations are atomic;
  - the same idempotency key never books twice;
  - nothing is confirmed without `user_confirmed`;
  - expired holds stop blocking.
- Errors are `BookingError(code, message, { suggested_next_action })`. Every response to an agent
  carries a `next_step`.
- **Units:** prices in minor units (`65000` = 650.00). Provider configs use weekday numbers
  (0 = Sunday). Times are ISO 8601 with the venue offset.
- **Never send customer names, emails or phone numbers** to analytics, logs or notifications.
- **Generated HTML/JS pages** (`studio/src/ui.ts`, `hosted/src/setup.ts`, `signup.ts`) are template
  literals: their client scripts avoid backticks and `${`.
- **Test behaviour for real:** run the server and do real MCP handshakes, not only unit tests. Bugs
  get a test that fails without the fix.
