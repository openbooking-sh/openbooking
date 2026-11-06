/**
 * What the database actually holds: owners' credentials encrypted, and the consent evidence kept
 * in the activity log. Run against a real server with TEST_DATABASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConsentEvidence } from '@openbooking-sh/core';
import { encryptedBusinessStore, type Business } from '@openbooking-sh/hosted';
import { PostgresActivityLog, PostgresBusinessStore } from '../src';
import { freshDb, target } from './helpers';

const NOW = '2026-10-06T07:00:00Z';
const KEY = randomBytes(32).toString('base64');

function business(id: string): Business {
  return {
    id,
    owner: { email: `${id}@example.com`, password_hash: 'scrypt$x$y' },
    settings: { listed: true } as Business['settings'],
    google: {
      tokens: {
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_at: 1_800_000_000_000,
      },
    },
    stripe: { secret_key: 'sk_live_secret_1234', webhook: { id: 'we_1', secret: 'whsec_abc' } },
    created_at: NOW,
    updated_at: NOW,
    version: 1,
  };
}

describe(`credentials at rest (${target})`, () => {
  it('writes ciphertext to the table, reads plain values, and encrypts older rows on request', async () => {
    const db = await freshDb();
    const plain = new PostgresBusinessStore(db);
    const store = encryptedBusinessStore(plain, { key: KEY });

    await plain.create(business('old-row')); // saved before the key existed
    await store.create(business('new-row'));

    const raw = async () =>
      (
        await db.query<{ id: string; data: string }>(
          'select id, data::text as data from ob_businesses order by id',
        )
      ).rows;
    let rows = await raw();
    expect(rows.find((r) => r.id === 'new-row')!.data).not.toMatch(
      /ya29|1\/\/refresh|sk_live|whsec/,
    );
    expect(rows.find((r) => r.id === 'old-row')!.data).toContain('sk_live_secret_1234');

    expect((await store.get('new-row'))!.stripe!.secret_key).toBe('sk_live_secret_1234');
    expect((await store.get('old-row'))!.google!.tokens.refresh_token).toBe('1//refresh');

    expect(await store.encryptAll()).toEqual({ businesses: 2, encrypted: 1 });
    rows = await raw();
    for (const r of rows) expect(r.data).not.toMatch(/ya29|1\/\/refresh|sk_live|whsec/);
    expect((await store.update('old-row', (b) => b))!.stripe!.webhook!.secret).toBe('whsec_abc');
  });
});

describe(`consent evidence in the activity log (${target})`, () => {
  it('is kept with the entry and comes back whole, per booking', async () => {
    const consent: ConsentEvidence = {
      user_confirmed: true,
      terms: {
        start: '2026-10-10T19:00:00+00:00',
        end: '2026-10-10T20:30:00+00:00',
        party_size: 2,
        offering: 'Dinner',
        price: { amount: 65000, currency: 'NOK' },
        deposit: null,
        cancellation_policy: {
          refundability: 'refundable',
          description: 'Free cancellation until 24h before.',
          free_cancellation_until: '2026-10-09T19:00:00+00:00',
          late_cancellation_fee: { amount: 20000, currency: 'NOK' },
          no_show_fee: null,
        },
      },
    };
    const log = new PostgresActivityLog(await freshDb(), { scope: 'studio-nord' });
    await log.add({
      at: NOW,
      operation: 'confirm',
      ok: true,
      booking_id: 'b1',
      status: 'confirmed',
      agent: 'Claude',
      protocol: 'mcp',
      consent,
    });
    const [entry] = await log.list({ booking_id: 'b1' });
    expect(entry!.consent).toEqual(consent);
  });
});
