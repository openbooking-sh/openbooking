# @openbooking-sh/postgres

**Postgres storage.** Durable stores for everything OpenBooking keeps: bookings and holds (with a per-resource lock so two servers can never sell the same time), idempotency records, Studio activity, Cal.com records, and the hosted account, calendar, email and rate-limit stores. Works with `pg` pools and PGlite.

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

```sh
npm install @openbooking-sh/postgres
```

## Usage

```ts
import { connectPostgres, migrate, postgresStores } from '@openbooking-sh/postgres';

const db = connectPostgres(process.env.DATABASE_URL!);
await migrate(db); // idempotent; safe on every start
const stores = postgresStores(db);
// stores.bookings, stores.idempotency, stores.activity, stores.calcom, ...
```

## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
