import { describe, expect, it } from 'vitest';
import { newApiKey } from '../../hosted/src/api-keys';
import { PostgresApiKeyStore } from '../src';
import { freshDb, target } from './helpers';

const NOW = '2026-10-06T07:00:00.000Z';
const make = (business: string, name: string, at = NOW) =>
  newApiKey(business, { name, scope: 'book' }, new Date(at)).stored;

describe(`PostgresApiKeyStore (${target})`, () => {
  it('stores, reads back, lists newest first, and keeps the secret only as a hash', async () => {
    const db = await freshDb();
    const store = new PostgresApiKeyStore(db);
    const a = make('salon', 'first', '2026-10-06T07:00:00.000Z');
    const b = make('salon', 'second', '2026-10-06T08:00:00.000Z');
    await store.create(a);
    await store.create(b);
    await store.create(make('other', 'elsewhere'));

    expect(await store.get(a.id)).toEqual(a);
    expect((await store.list('salon')).map((k) => k.name)).toEqual(['second', 'first']);
    expect(await store.get('nope')).toBeUndefined();

    const { rows } = await db.query('select * from ob_api_keys where id = $1', [a.id]);
    expect(Object.keys(rows[0]!)).not.toContain('secret');
    expect(rows[0]!.secret_hash).toBe(a.secret_hash);
  });

  it('is shared by every instance: a revoke on one stops the key on the other', async () => {
    const db = await freshDb();
    const k = make('salon', 'site');
    await new PostgresApiKeyStore(db).create(k);

    expect(await new PostgresApiKeyStore(db).revoke('salon', k.id, NOW)).toBe(true);
    expect((await new PostgresApiKeyStore(db).get(k.id))?.revoked_at).toBe(NOW);
    // Once only, and only by the business that owns it.
    expect(await new PostgresApiKeyStore(db).revoke('salon', k.id, NOW)).toBe(false);
    const other = make('salon', 'second');
    await new PostgresApiKeyStore(db).create(other);
    expect(await new PostgresApiKeyStore(db).revoke('someone-else', other.id, NOW)).toBe(false);
    expect((await new PostgresApiKeyStore(db).get(other.id))?.revoked_at).toBeUndefined();
  });

  it('records last use and deletes a business’s keys without touching others', async () => {
    const db = await freshDb();
    const store = new PostgresApiKeyStore(db);
    const mine = make('salon', 'site');
    const theirs = make('other', 'site');
    await store.create(mine);
    await store.create(theirs);

    await store.touch(mine.id, '2026-10-07T10:00:00.000Z');
    expect((await store.get(mine.id))?.last_used_at).toBe('2026-10-07T10:00:00.000Z');

    await store.deleteScope('salon');
    expect(await store.list('salon')).toEqual([]);
    expect(await store.get(theirs.id)).toBeDefined();
  });
});
