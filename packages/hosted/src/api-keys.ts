/**
 * API keys for one business's booking API. A site with no backend of its own (an AI-built static
 * page) puts one in its code and calls `/b/<id>/api/*` or `/b/<id>/mcp`. The key is shown once; only
 * a hash is stored. A key names who is calling, limits what they may do (`read` or `book`), can be
 * revoked on its own, and is rate-limited on its own. It is not a lock: public access still works
 * without a key, as it did before keys existed.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** `read`: business info and availability. `book`: also holds, bookings and the MCP endpoint. */
export type ApiKeyScope = 'read' | 'book';

export interface StoredApiKey {
  /** Public part of the key (also what Studio lists and revokes by). */
  id: string;
  business_id: string;
  name: string;
  scope: ApiKeyScope;
  /** SHA-256 of the secret part. The secret is random, so a fast hash is enough. */
  secret_hash: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

/** What Studio shows: never the secret or its hash. */
export interface ApiKeyView {
  id: string;
  name: string;
  scope: ApiKeyScope;
  /** The start of the key, enough to recognise it. */
  prefix: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

export interface ApiKeyStore {
  create(key: StoredApiKey): Promise<void>;
  get(id: string): Promise<StoredApiKey | undefined>;
  /** Newest first. */
  list(businessId: string): Promise<StoredApiKey[]>;
  /** Resolves false when the business has no such key, or it was revoked already. */
  revoke(businessId: string, id: string, at: string): Promise<boolean>;
  touch(id: string, at: string): Promise<void>;
  /** Remove every key of a business (closing the account). */
  deleteScope(businessId: string): Promise<void>;
}

export class MemoryApiKeyStore implements ApiKeyStore {
  readonly #keys = new Map<string, StoredApiKey>();

  async create(key: StoredApiKey) {
    this.#keys.set(key.id, { ...key });
  }

  async get(id: string) {
    const k = this.#keys.get(id);
    return k && { ...k };
  }

  async list(businessId: string) {
    return [...this.#keys.values()]
      .filter((k) => k.business_id === businessId)
      .map((k) => ({ ...k }))
      .reverse();
  }

  async revoke(businessId: string, id: string, at: string) {
    const k = this.#keys.get(id);
    if (!k || k.business_id !== businessId || k.revoked_at) return false;
    k.revoked_at = at;
    return true;
  }

  async touch(id: string, at: string) {
    const k = this.#keys.get(id);
    if (k) k.last_used_at = at;
  }

  async deleteScope(businessId: string) {
    for (const [id, k] of this.#keys) if (k.business_id === businessId) this.#keys.delete(id);
  }
}

const PREFIX = 'obk_';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 12;

/** Active keys a business may hold at once. */
export const MAX_ACTIVE_API_KEYS = 10;
/** `last_used_at` is written at most this often per key, so reads stay reads. */
export const TOUCH_EVERY_MS = 5 * 60_000;

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** A new key: the full string (show it once) and the record to store. */
export function newApiKey(
  businessId: string,
  input: { name: string; scope: ApiKeyScope },
  now: Date,
): { key: string; stored: StoredApiKey } {
  const bytes = randomBytes(ID_LENGTH);
  const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
  const secret = randomBytes(32).toString('base64url');
  return {
    key: `${PREFIX}${id}_${secret}`,
    stored: {
      id,
      business_id: businessId,
      name: input.name,
      scope: input.scope,
      secret_hash: hashSecret(secret),
      created_at: now.toISOString(),
    },
  };
}

export function apiKeyView(k: StoredApiKey): ApiKeyView {
  return {
    id: k.id,
    name: k.name,
    scope: k.scope,
    prefix: `${PREFIX}${k.id}_…`,
    created_at: k.created_at,
    ...(k.last_used_at ? { last_used_at: k.last_used_at } : {}),
    ...(k.revoked_at ? { revoked_at: k.revoked_at } : {}),
  };
}

/**
 * The key a request carries, if any: `x-openbooking-key`, or a Bearer token that looks like one
 * of ours (other Bearer tokens, such as USP credentials, are not ours to judge).
 */
export function apiKeyFromHeaders(headers: Headers): string | undefined {
  const given = headers.get('x-openbooking-key')?.trim();
  if (given) return given;
  const bearer = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  return bearer.startsWith(PREFIX) ? bearer : undefined;
}

export type KeyCheck =
  { ok: true; key: StoredApiKey } | { ok: false; reason: 'invalid' | 'insufficient_scope' };

/** Does `given` name a live key of this business that may do `needed`? */
export async function checkApiKey(
  store: ApiKeyStore,
  given: string,
  businessId: string,
  needed: ApiKeyScope,
): Promise<KeyCheck> {
  const match = /^obk_([a-z0-9]{12})_([A-Za-z0-9_-]{20,100})$/.exec(given);
  const stored = match ? await store.get(match[1]!) : undefined;
  // One answer for unknown, revoked, wrong-business and wrong-secret keys.
  if (!match || !stored || stored.revoked_at || stored.business_id !== businessId) {
    return { ok: false, reason: 'invalid' };
  }
  const want = Buffer.from(stored.secret_hash);
  const have = Buffer.from(hashSecret(match[2]!));
  if (want.length !== have.length || !timingSafeEqual(want, have)) {
    return { ok: false, reason: 'invalid' };
  }
  if (needed === 'book' && stored.scope !== 'book') {
    return { ok: false, reason: 'insufficient_scope' };
  }
  return { ok: true, key: stored };
}

/**
 * What a request to a business needs a key for. `path` is relative to the business
 * (`/book/api/hold`, `/mcp`). Pages, embeds, UCP, A2A and USP are not governed by keys: USP and the
 * rest have their own ways to say who is calling.
 */
export function scopeNeeded(method: string, path: string): ApiKeyScope | undefined {
  if (method === 'OPTIONS') return undefined;
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'book';
  if (!path.startsWith('/book/api/')) return undefined;
  const readOnly = ['/book/api/info', '/book/api/availability', '/book/api/openapi.json'];
  return method === 'GET' && readOnly.includes(path) ? 'read' : 'book';
}
