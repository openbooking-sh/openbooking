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
  {
    version: 2,
    name: 'hosted',
    sql: `
      create table ob_businesses (
        id          text primary key,
        -- Lower-cased; one account per email.
        owner_email text not null,
        created_at  timestamptz not null,
        data        jsonb not null
      );
      create unique index ob_businesses_owner_email on ob_businesses (owner_email);

      create table ob_calendar_links (
        booking_id  text primary key,
        calendar_id text not null,
        event_id    text not null
      );

      create table ob_notification_log (
        key        text primary key,
        claimed_at timestamptz not null default now()
      );

      create table ob_rate_limits (
        key          text primary key,
        window_start timestamptz not null,
        count        integer not null
      );

      -- Activity per business on a hosted deployment ('' for single-business servers).
      alter table ob_activity add column scope text not null default '';
      create index ob_activity_scope on ob_activity (scope, id desc);
    `,
  },
  {
    version: 3,
    name: 'row-level-security',
    // Customer contact details live in these tables. With RLS on and no policies, a role that
    // does not own the tables (the anon role of a REST or Data API layer, say) sees nothing; the
    // owner role OpenBooking connects as is unaffected.
    sql: `
      alter table ob_bookings enable row level security;
      alter table ob_idempotency enable row level security;
      alter table ob_activity enable row level security;
      alter table ob_booked_via enable row level security;
      alter table ob_calcom_records enable row level security;
      alter table ob_businesses enable row level security;
      alter table ob_calendar_links enable row level security;
      alter table ob_notification_log enable row level security;
      alter table ob_rate_limits enable row level security;
      alter table ob_migrations enable row level security;
    `,
  },
  {
    version: 4,
    name: 'usp-state',
    // What the USP adapter must remember between requests and across server instances: who owns
    // which hold or booking, booking-scoped credentials (by hash, never the value), proofs already
    // seen (replay defence), which platform key came with which profile, and what request an
    // Idempotency-Key was first used for. No customer names, emails or phone numbers live here.
    sql: `
      create table ob_usp_owners (
        booking_id text primary key,
        principal  text not null,
        -- Set once a booking was created from the hold: reads then count as a booking.
        is_booking boolean not null default false,
        created_at timestamptz not null default now()
      );

      create table ob_usp_credentials (
        hash       text primary key,
        jkt        text,
        scope      jsonb not null,
        expires_at timestamptz not null
      );
      create index ob_usp_credentials_expires on ob_usp_credentials (expires_at);

      create table ob_usp_proofs (
        jti        text primary key,
        expires_at timestamptz not null
      );
      create index ob_usp_proofs_expires on ob_usp_proofs (expires_at);

      create table ob_usp_profile_bindings (
        jkt         text primary key,
        profile_uri text not null,
        created_at  timestamptz not null default now()
      );

      create table ob_usp_request_keys (
        scoped_key  text primary key,
        fingerprint text not null,
        expires_at  timestamptz not null
      );
      create index ob_usp_request_keys_expires on ob_usp_request_keys (expires_at);

      alter table ob_usp_owners enable row level security;
      alter table ob_usp_credentials enable row level security;
      alter table ob_usp_proofs enable row level security;
      alter table ob_usp_profile_bindings enable row level security;
      alter table ob_usp_request_keys enable row level security;
    `,
  },
  {
    version: 5,
    name: 'email-suppressions',
    // Addresses that unsubscribed from a business's emails, kept as a hash of the normalised
    // address (never the address) per business. Survives restarts and is shared by every instance.
    sql: `
      create table ob_email_suppressions (
        business_id  text not null,
        address_hash text not null,
        created_at   timestamptz not null default now(),
        primary key (business_id, address_hash)
      );

      alter table ob_email_suppressions enable row level security;
    `,
  },
];

/**
 * Bring the schema up to date. Safe to call on every start and from many instances at once: an
 * advisory lock serialises migrators, and each migration runs in its own transaction.
 */
export async function migrate(db: Db): Promise<number[]> {
  // Cold-start fast path: a database that already has every migration (nearly every boot) is
  // recognised with one read, instead of BEGIN, lock, create-if-missing, select and COMMIT, which
  // cost five round trips to the database. This is safe without the lock because rows in
  // ob_migrations are committed together with the migration they record, so seeing all of them
  // means nothing is pending; anything else falls through to the locked path below.
  if (await upToDate(db)) return [];
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

/** True when every known migration is recorded. A missing table means a fresh database. */
async function upToDate(db: Db): Promise<boolean> {
  try {
    const { rows } = await db.query<{ version: number }>('select version from ob_migrations');
    const done = new Set(rows.map((r) => Number(r.version)));
    return MIGRATIONS.every((m) => done.has(m.version));
  } catch (error) {
    // 42P01: undefined_table. Anything else (auth, network) is a real failure.
    if ((error as { code?: string }).code === '42P01') return false;
    throw error;
  }
}

/** Split a migration script on `;` (our migrations contain no functions or quoted semicolons). */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
