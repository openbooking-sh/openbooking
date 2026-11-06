import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryBusinessStore,
  SecretsError,
  createHostedApp,
  encryptedBusinessStore,
  starterSettings,
  type Business,
} from '../src';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

const GOOGLE = {
  access_token: 'ya29.access-token-value',
  refresh_token: '1//refresh-token-value',
  expires_at: 1_800_000_000_000,
  email: 'owner@example.com',
};
const STRIPE = { secret_key: 'sk_live_secret_1234', webhook: { id: 'we_1', secret: 'whsec_abc' } };
const PLAINTEXTS = [
  GOOGLE.access_token,
  GOOGLE.refresh_token,
  STRIPE.secret_key,
  STRIPE.webhook.secret,
];

function business(id = 'studio-nord'): Business {
  return {
    id,
    owner: { email: `${id}@example.com`, password_hash: 'x' },
    settings: starterSettings({
      name: 'Studio Nord',
      ownerName: 'Maria Berg',
      category: 'hair_salon',
    }),
    google: { tokens: structuredClone(GOOGLE) },
    stripe: structuredClone(STRIPE),
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    version: 1,
  };
}

const rawText = async (inner: MemoryBusinessStore) => JSON.stringify(await inner.list());

describe('encrypting credentials at rest', () => {
  it('stores Google tokens and Stripe keys encrypted, and reads them back whole', async () => {
    const inner = new MemoryBusinessStore();
    const store = encryptedBusinessStore(inner, { key: KEY });
    await store.create(business());

    const raw = await rawText(inner);
    for (const secret of PLAINTEXTS) expect(raw).not.toContain(secret);
    expect(raw).toContain('enc:v1:');

    const read = (await store.get('studio-nord'))!;
    expect(read.google!.tokens).toEqual(GOOGLE);
    expect(read.stripe).toEqual(STRIPE);
    // Fields that are not secrets are left readable.
    expect(JSON.parse(raw)[0].google.tokens.email).toBe('owner@example.com');
    expect((await store.getByEmail('studio-nord@example.com'))!.stripe!.secret_key).toBe(
      STRIPE.secret_key,
    );
  });

  it('encrypts on a later save too, and the callback sees plain values', async () => {
    const inner = new MemoryBusinessStore();
    const store = encryptedBusinessStore(inner, { key: KEY });
    await store.create({ ...business(), google: undefined, stripe: undefined });

    let seen = '';
    const saved = await store.update('studio-nord', (b) => {
      seen = b.stripe?.secret_key ?? '';
      return { ...b, stripe: { secret_key: 'sk_live_new_5678' } };
    });
    expect(saved!.stripe!.secret_key).toBe('sk_live_new_5678');
    expect(await rawText(inner)).not.toContain('sk_live_new_5678');

    await store.update('studio-nord', (b) => {
      seen = b.stripe!.secret_key;
      return b;
    });
    expect(seen).toBe('sk_live_new_5678');
  });

  it('uses a fresh random value each time', async () => {
    const inner = new MemoryBusinessStore();
    const store = encryptedBusinessStore(inner, { key: KEY });
    await store.create(business('a'));
    await store.create(business('b'));
    const [a, b] = await inner.list();
    expect(a!.stripe!.secret_key).not.toBe(b!.stripe!.secret_key);
  });

  it('still reads records written before the key existed, and encrypts them on request', async () => {
    const inner = new MemoryBusinessStore();
    await inner.create(business('a'));
    await inner.create(business('b'));
    const store = encryptedBusinessStore(inner, { key: KEY });

    expect((await store.get('a'))!.google!.tokens.refresh_token).toBe(GOOGLE.refresh_token);
    expect(await rawText(inner)).toContain(GOOGLE.refresh_token);

    expect(await store.encryptAll()).toEqual({ businesses: 2, encrypted: 2 });
    const raw = await rawText(inner);
    for (const secret of PLAINTEXTS) expect(raw).not.toContain(secret);
    expect((await store.get('b'))!.stripe).toEqual(STRIPE);

    // Nothing left to do the second time.
    expect(await store.encryptAll()).toEqual({ businesses: 2, encrypted: 0 });
  });

  it('fails loudly, without the ciphertext as a token, when the key is missing or wrong', async () => {
    const inner = new MemoryBusinessStore();
    await encryptedBusinessStore(inner, { key: KEY }).create(business());

    const noKey = encryptedBusinessStore(inner);
    await expect(noKey.get('studio-nord')).rejects.toThrow(/TOKEN_ENCRYPTION_KEY is not set/);
    await expect(noKey.encryptAll()).rejects.toBeInstanceOf(SecretsError);

    const wrong = encryptedBusinessStore(inner, { key: OTHER_KEY });
    const err = await wrong.get('studio-nord').catch((e: Error) => e);
    expect(err).toBeInstanceOf(SecretsError);
    expect((err as Error).message).toMatch(/could not be decrypted/);
    for (const secret of PLAINTEXTS) expect((err as Error).message).not.toContain(secret);
  });

  it('does not open a value copied to another business or field', async () => {
    const inner = new MemoryBusinessStore();
    const store = encryptedBusinessStore(inner, { key: KEY });
    await store.create(business('a'));
    await store.create(business('b'));
    const [a] = await inner.list();
    await inner.update('b', (b) => ({
      ...b,
      stripe: { ...b.stripe!, secret_key: a!.stripe!.secret_key },
    }));
    await expect(store.get('b')).rejects.toThrow(/could not be decrypted/);

    await inner.update('a', (x) => ({
      ...x,
      stripe: { ...x.stripe!, secret_key: x.google!.tokens.refresh_token },
    }));
    await expect(store.get('a')).rejects.toThrow(/could not be decrypted/);
  });

  it('refuses a key of the wrong size, and a missing key when one is required', () => {
    const inner = new MemoryBusinessStore();
    expect(() => encryptedBusinessStore(inner, { key: 'too-short' })).toThrow(/32 bytes/);
    expect(() => encryptedBusinessStore(inner, { required: true })).toThrow(
      /TOKEN_ENCRYPTION_KEY is required/,
    );
    // A 64-character hex key is fine too.
    expect(() =>
      encryptedBusinessStore(inner, { key: randomBytes(32).toString('hex') }),
    ).not.toThrow();
  });
});

describe('the hosted app', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  function app(options: { key?: string; cronSecret?: string } = {}) {
    const inner = new MemoryBusinessStore();
    const hosted = createHostedApp({
      baseUrl: 'http://localhost:3000',
      sessionSecret: 'test-secret-0123456789',
      businesses: inner,
      ...(options.key ? { tokenEncryptionKey: options.key } : {}),
      ...(options.cronSecret ? { cronSecret: options.cronSecret } : {}),
    });
    cleanups.push(hosted.close);
    return { hosted, inner };
  }

  it('keeps what it saves for an owner encrypted in the store', async () => {
    const { hosted, inner } = app({ key: KEY });
    await hosted.businesses.create(business());
    expect(await rawText(inner)).not.toContain(GOOGLE.refresh_token);
    expect((await hosted.businesses.get('studio-nord'))!.google!.tokens.refresh_token).toBe(
      GOOGLE.refresh_token,
    );
  });

  it('refuses to start without a key when one is required', () => {
    expect(() =>
      createHostedApp({
        baseUrl: 'http://localhost:3000',
        sessionSecret: 'test-secret-0123456789',
        requireTokenEncryption: true,
      }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY is required/);
  });

  it('encrypts older records through the maintenance route, only with the cron secret', async () => {
    const { hosted, inner } = app({ key: KEY, cronSecret: 'cron-secret-123' });
    await inner.create(business());

    const url = 'http://localhost:3000/api/maintenance/encrypt-secrets';
    expect((await hosted.app.request(url)).status).toBe(401);
    expect(await rawText(inner)).toContain(GOOGLE.refresh_token);

    const ok = await hosted.app.request(url, {
      headers: { authorization: 'Bearer cron-secret-123' },
    });
    expect(await ok.json()).toEqual({ ok: true, businesses: 1, encrypted: 1 });
    expect(await rawText(inner)).not.toContain(GOOGLE.refresh_token);
  });
});
