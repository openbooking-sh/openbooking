import { describe, expect, it } from 'vitest';
import { describeUspState } from '../../adapter-usp/test/state-contract';
import { PostgresUspState, postgresStores } from '../src';
import { freshDb, target } from './helpers';

describeUspState(
  `postgres (${target})`,
  async (clock) => new PostgresUspState(await freshDb(), { now: () => clock.now }),
);

describe(`PostgresUspState specifics (${target})`, () => {
  const start = Date.parse('2030-01-01T00:00:00Z');

  it('forgets an Idempotency-Key after its time to live, so the key counts as new', async () => {
    let now = start;
    const store = new PostgresUspState(await freshDb(), {
      now: () => now,
      requestKeyTtlMs: 3600_000,
    });
    expect(await store.checkKey('k', 'fp-a')).toBe(true);
    expect(await store.checkKey('k', 'fp-b')).toBe(false);
    now += 3600_001;
    expect(await store.checkKey('k', 'fp-b')).toBe(true);
    expect(await store.checkKey('k', 'fp-a')).toBe(false);
  });

  it('purges expired proofs, keys and credentials, and nothing else', async () => {
    let now = start;
    const db = await freshDb();
    const store = new PostgresUspState(db, { now: () => now, purgeEvery: 0 });
    await store.seenJti('jti-old', 1000);
    await store.seenJti('jti-new', 10 * 3600_000);
    await store.checkKey('key-old', 'fp');
    await store.saveCredential({ hash: 'cred-old', expiresAt: new Date(start + 1000), scope: [] });
    await store.saveCredential({
      hash: 'cred-new',
      expiresAt: new Date(start + 10 * 3600_000),
      scope: [],
    });
    await store.claim('bk_1', 'platform-a');
    await store.bindProfile('jkt-1', 'https://a.example/p.json');

    now += 5000;
    expect(await store.purgeExpired()).toBe(2); // jti-old and cred-old; the key lives for 48h
    expect(await store.seenJti('jti-new', 1000)).toBe(true);
    expect(await store.findCredential('cred-old')).toBeUndefined();
    expect(await store.findCredential('cred-new')).toBeDefined();
    // Ownership and bindings never expire.
    expect(await store.ownerOf('bk_1')).toBe('platform-a');
    expect(await store.bindProfile('jkt-1', 'https://a.example/p.json')).toBe(true);
  });

  it('shares state between instances on one database', async () => {
    const db = await freshDb();
    const one = new PostgresUspState(db);
    const two = new PostgresUspState(db);
    await one.claim('bk_1', 'platform-a');
    expect(await two.ownerOf('bk_1')).toBe('platform-a');
    expect(await two.claim('bk_1', 'platform-b')).toBe(false);
    expect(await one.seenJti('jti-1', 120_000)).toBe(false);
    expect(await two.seenJti('jti-1', 120_000)).toBe(true);
    await one.saveCredential({
      hash: 'h',
      expiresAt: new Date(Date.now() + 3600_000),
      jkt: 'jkt-1',
      scope: ['booking:bk_1'],
    });
    expect((await two.findCredential('h'))?.scope).toEqual(['booking:bk_1']);
  });

  it('is part of postgresStores, and its tables hold no customer details', async () => {
    const db = await freshDb();
    expect(postgresStores(db).usp).toBeInstanceOf(PostgresUspState);
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = current_schema() and table_name like 'ob_usp_%'`,
    );
    expect(rows.length).toBeGreaterThan(10);
    const columns = rows.map((r) => r.column_name);
    for (const forbidden of ['email', 'first_name', 'last_name', 'phone', 'customer', 'name']) {
      expect(columns).not.toContain(forbidden);
    }
  });
});
