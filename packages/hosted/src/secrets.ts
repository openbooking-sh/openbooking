import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Business, BusinessStore } from './business';

/**
 * Encrypts what a business's record holds that can act on the owner's behalf (Google Calendar
 * tokens, the Stripe key and its webhook secret) before it reaches the database, so a leaked
 * backup or a copied Neon branch is not enough to use them. AES-256-GCM, one random IV per value,
 * and each value is tied to its business and field, so one copied into another row stops opening.
 * The key lives in the environment (`TOKEN_ENCRYPTION_KEY`), never next to the data.
 */

const PREFIX = 'enc:v1:';

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

/** Parse a 32-byte key given as base64 or as 64 hex characters. */
export function parseEncryptionKey(value: string): Buffer {
  const v = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32) {
    throw new SecretsError(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes, as base64 or 64 hex characters. ' +
        "Make one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

type Fields = Record<string, unknown>;
const fields = (o: unknown) => o as Fields | undefined;

/** The secret fields of a business record, as the object that holds each and its name there. */
const SECRET_FIELDS: ReadonlyArray<{
  path: string;
  holder: (b: Business) => Fields | undefined;
  key: string;
}> = [
  { path: 'google.access_token', holder: (b) => fields(b.google?.tokens), key: 'access_token' },
  { path: 'google.refresh_token', holder: (b) => fields(b.google?.tokens), key: 'refresh_token' },
  { path: 'stripe.secret_key', holder: (b) => fields(b.stripe), key: 'secret_key' },
  { path: 'stripe.webhook_secret', holder: (b) => fields(b.stripe?.webhook), key: 'secret' },
];

function encrypt(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function decrypt(key: Buffer, sealed: string, aad: string): string {
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // Never say more than this: the message may end up in logs.
    throw new SecretsError(
      `A stored secret (${aad.split('\n')[1]}) could not be decrypted. TOKEN_ENCRYPTION_KEY is not the key it was written with.`,
    );
  }
}

const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);
const isPlain = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && !v.startsWith(PREFIX);

export interface EncryptedBusinessStore extends BusinessStore {
  /**
   * Encrypt the secrets of every business still holding them in plain text (records written
   * before the key was set). Safe to run any time and more than once.
   */
  encryptAll(): Promise<{ businesses: number; encrypted: number }>;
}

/**
 * Wrap a business store so secrets are encrypted on the way in and decrypted on the way out.
 *
 * Without a `key`, new secrets are stored as they are, but a record that already holds an
 * encrypted one fails loudly instead of handing out the ciphertext as if it were a token. With
 * `required`, a missing key stops start-up. Plain-text values from before the key was set still
 * read fine, and are encrypted the next time their business is saved or by `encryptAll`.
 */
export function encryptedBusinessStore(
  inner: BusinessStore,
  options: { key?: string; required?: boolean } = {},
): EncryptedBusinessStore {
  if (!options.key && options.required) {
    throw new SecretsError(
      'TOKEN_ENCRYPTION_KEY is required: owners’ Google and Stripe credentials must not be stored in plain text. ' +
        'Set it, or leave TOKEN_ENCRYPTION_REQUIRED unset to run without encryption.',
    );
  }
  const key = options.key ? parseEncryptionKey(options.key) : undefined;

  const map = (b: Business, how: (value: string, aad: string) => string | undefined): Business => {
    const copy = structuredClone(b);
    for (const f of SECRET_FIELDS) {
      const holder = f.holder(copy);
      const value = holder?.[f.key];
      if (!holder || typeof value !== 'string') continue;
      const next = how(value, `${b.id}\n${f.path}`);
      if (next !== undefined) holder[f.key] = next;
    }
    return copy;
  };

  const seal = (b: Business) =>
    map(b, (v, aad) => (key && isPlain(v) ? encrypt(key, v, aad) : undefined));
  const open = (b: Business) =>
    map(b, (v, aad) => {
      if (!isSealed(v)) return undefined;
      if (!key) {
        throw new SecretsError(
          'This business holds encrypted credentials but TOKEN_ENCRYPTION_KEY is not set.',
        );
      }
      return decrypt(key, v, aad);
    });

  return {
    create: (b) => inner.create(seal(b)),
    get: async (id) => {
      const b = await inner.get(id);
      return b && open(b);
    },
    getByEmail: async (email) => {
      const b = await inner.getByEmail(email);
      return b && open(b);
    },
    update: async (id, fn) => {
      const saved = await inner.update(id, (stored) => seal(fn(open(stored))));
      return saved && open(saved);
    },
    list: async () => (await inner.list()).map(open),
    ...(inner.delete ? { delete: (id: string) => inner.delete!(id) } : {}),
    async encryptAll() {
      if (!key)
        throw new SecretsError('Set TOKEN_ENCRYPTION_KEY before encrypting stored secrets.');
      const all = await inner.list();
      let encrypted = 0;
      for (const stored of all) {
        const hasPlain = SECRET_FIELDS.some((f) => isPlain(f.holder(stored)?.[f.key]));
        if (!hasPlain) continue;
        // `seal` skips values that are already encrypted, so a business saved meanwhile is fine.
        await inner.update(stored.id, seal);
        encrypted++;
      }
      return { businesses: all.length, encrypted };
    },
  };
}
