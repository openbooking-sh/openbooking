import { LOCK_SQL, type Db } from './db';

/**
 * Schema migrations, applied in order and recorded in `ob_migrations`. Never edit a shipped
 * migration; append a new one.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial',
    sql: `
      create table ob_bookings (
        booking_id  text primary key,
        venue_id    text not null,
        resource_id text not null,
        start_at    timestamptz not null,
        -- End including turnover buffer: the span the resource is occupied.
        end_at      timestamptz not null,
        status      text not null,
        expires_at  timestamptz,
        created_at  timestamptz not null,
        data        jsonb not null
      );
      create index ob_bookings_inventory on ob_bookings (venue_id, resource_id, start_at);
      create index ob_bookings_start on ob_bookings (start_at);
      create index ob_bookings_created on ob_bookings (created_at desc);

      create table ob_idempotency (
        key         text primary key,
        fingerprint text not null,
        value       jsonb,
        created_at  timestamptz not null,
        expires_at  timestamptz not null
      );
      create index ob_idempotency_expires on ob_idempotency (expires_at);

      create table ob_activity (
        id         bigserial primary key,
        at         timestamptz not null,
        booking_id text,
        agent      text not null,
        entry      jsonb not null
      );
      create index ob_activity_booking on ob_activity (booking_id, id desc);

      create table ob_booked_via (
        booking_id text primary key,
        agent      text not null,
        credit     text not null
      );

      create table ob_calcom_records (
        booking_id text primary key,
        created_at timestamptz not null default now(),
        data       jsonb not null
      );
    `,
  },
];

/**
 * Bring the schema up to date. Safe to call on every start and from many instances at once: an
 * advisory lock serialises migrators, and each migration runs in its own transaction.
 */
export async function migrate(db: Db): Promise<number[]> {
  return db.transaction(async (tx) => {
    await tx.query(LOCK_SQL, ['openbooking:migrate']);
    await tx.query(
      `create table if not exists ob_migrations (
         version    integer primary key,
         name       text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const { rows } = await tx.query<{ version: number }>('select version from ob_migrations');
    const done = new Set(rows.map((r) => Number(r.version)));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      // One statement per query: some drivers (and PGlite's extended protocol) take only one.
      for (const statement of splitStatements(m.sql)) await tx.query(statement);
      await tx.query('insert into ob_migrations (version, name) values ($1, $2)', [
        m.version,
        m.name,
      ]);
      applied.push(m.version);
    }
    return applied;
  });
}

/** Split a migration script on `;` (our migrations contain no functions or quoted semicolons). */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
