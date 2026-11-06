import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@openbooking-sh/core';
import { MemoryApiKeyStore, createHostedApp } from '../src';
import {
  apiKeyFromHeaders,
  apiKeyView,
  checkApiKey,
  newApiKey,
  scopeNeeded,
} from '../src/api-keys';

const BASE = 'http://localhost:3000';
// Tuesday 6 October 2026, 09:00 in Oslo.
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';

describe('API key format and checks', () => {
  it('stores a hash, never the secret, and shows the key once', async () => {
    const { key, stored } = newApiKey('salon', { name: 'Site', scope: 'read' }, new Date(NOW));
    expect(key).toMatch(/^obk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const secret = key.split('_').slice(2).join('_');
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(apiKeyView(stored))).not.toContain(stored.secret_hash);
    expect(JSON.stringify(apiKeyView(stored))).not.toContain(secret);
  });

  it('accepts only a live key of this business with enough scope', async () => {
    const store = new MemoryApiKeyStore();
    const read = newApiKey('salon', { name: 'Read', scope: 'read' }, new Date(NOW));
    const book = newApiKey('salon', { name: 'Book', scope: 'book' }, new Date(NOW));
    await store.create(read.stored);
    await store.create(book.stored);

    expect((await checkApiKey(store, read.key, 'salon', 'read')).ok).toBe(true);
    expect((await checkApiKey(store, book.key, 'salon', 'book')).ok).toBe(true);
    // A booking key may also read; a read key may not book.
    expect((await checkApiKey(store, book.key, 'salon', 'read')).ok).toBe(true);
    expect(await checkApiKey(store, read.key, 'salon', 'book')).toEqual({
      ok: false,
      reason: 'insufficient_scope',
    });
    // Another business, a wrong secret, an unknown id and garbage all look the same.
    const invalid = { ok: false, reason: 'invalid' };
    expect(await checkApiKey(store, read.key, 'other-salon', 'read')).toEqual(invalid);
    expect(await checkApiKey(store, `${read.key.slice(0, -4)}AAAA`, 'salon', 'read')).toEqual(
      invalid,
    );
    expect(await checkApiKey(store, 'obk_aaaaaaaaaaaa_' + 'x'.repeat(43), 'salon', 'read')).toEqual(
      invalid,
    );
    expect(await checkApiKey(store, 'nonsense', 'salon', 'read')).toEqual(invalid);

    await store.revoke('salon', read.stored.id, NOW);
    expect(await checkApiKey(store, read.key, 'salon', 'read')).toEqual(invalid);
  });

  it('reads the key from x-openbooking-key or an obk_ Bearer token, and leaves other tokens alone', () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(apiKeyFromHeaders(h({ 'x-openbooking-key': 'obk_a_b' }))).toBe('obk_a_b');
    expect(apiKeyFromHeaders(h({ authorization: 'Bearer obk_a_b' }))).toBe('obk_a_b');
    // USP credentials and Studio session tokens travel as Bearer tokens too.
    expect(apiKeyFromHeaders(h({ authorization: 'Bearer eyJhbGciOi' }))).toBeUndefined();
    expect(apiKeyFromHeaders(h({}))).toBeUndefined();
  });

  it('asks for a key only on the booking API and MCP', () => {
    expect(scopeNeeded('GET', '/book/api/info')).toBe('read');
    expect(scopeNeeded('GET', '/book/api/availability')).toBe('read');
    expect(scopeNeeded('GET', '/book/api/openapi.json')).toBe('read');
    expect(scopeNeeded('POST', '/book/api/hold')).toBe('book');
    expect(scopeNeeded('GET', '/book/api/holds/h1')).toBe('book');
    expect(scopeNeeded('GET', '/book/api/bookings/b1')).toBe('book');
    expect(scopeNeeded('POST', '/mcp')).toBe('book');
    expect(scopeNeeded('OPTIONS', '/book/api/hold')).toBeUndefined();
    expect(scopeNeeded('GET', '/book')).toBeUndefined();
    expect(scopeNeeded('GET', '/book/embed.js')).toBeUndefined();
    expect(scopeNeeded('GET', '/.well-known/usp')).toBeUndefined();
    expect(scopeNeeded('POST', '/usp/holds')).toBeUndefined();
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const apiKeys = new MemoryApiKeyStore();
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock: new ManualClock(NOW),
    apiKeys,
  });
  cleanups.push(hosted.close);
  const req = async (
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      token?: string;
      key?: string;
      bearerKey?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const res = await hosted.app.request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.bearerKey ? { authorization: `Bearer ${opts.bearerKey}` } : {}),
        ...(opts.key ? { 'x-openbooking-key': opts.key } : {}),
        ...opts.headers,
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const signup = async (name: string, email: string) => {
    const r = await req('/api/signup', {
      body: {
        business_name: name,
        your_name: 'Owner',
        email,
        password: 'correct horse',
        category: 'hair_salon',
        city: 'Oslo',
      },
    });
    expect(r.status, r.text).toBe(200);
    return { token: r.json.token as string, id: r.json.business_id as string };
  };
  const makeKey = async (token: string, name: string, scope: 'read' | 'book') => {
    const r = await req('/studio/api/api-keys', { token, body: { name, scope } });
    expect(r.status, r.text).toBe(200);
    return r.json as { key: string; id: string };
  };
  return { hosted, apiKeys, req, signup, makeKey };
}

describe('API keys on hosted', () => {
  it('lists keys without the secret, shows the new key once, and counts last use', async () => {
    const { hosted, req, signup, makeKey, apiKeys } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const made = await makeKey(a.token, 'My website', 'read');

    const list = await req('/studio/api/api-keys', { token: a.token });
    expect(list.json.keys).toHaveLength(1);
    expect(list.json.keys[0]).toMatchObject({ id: made.id, name: 'My website', scope: 'read' });
    expect(list.text).not.toContain(made.key);
    expect(list.text).not.toContain((await apiKeys.get(made.id))!.secret_hash);
    expect(list.json.keys[0].last_used_at).toBeUndefined();

    expect((await req(`/b/${a.id}/book/api/info`, { key: made.key })).status).toBe(200);
    await hosted.idle();
    const used = await req('/studio/api/api-keys', { token: a.token });
    expect(used.json.keys[0].last_used_at).toBe('2026-10-06T07:00:00.000Z');
  });

  it('keeps public access working without a key', async () => {
    const { req, signup } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const info = await req(`/b/${a.id}/book/api/info`);
    expect(info.status, info.text).toBe(200);
    const slots = await req(
      `/b/${a.id}/book/api/availability?date=${DAY}&service=${info.json.services[0].id}`,
    );
    expect(slots.status).toBe(200);
    expect(slots.json.slots.length).toBeGreaterThan(0);
    // A Bearer token that is not one of ours (a USP credential, say) is not judged here.
    expect((await req(`/b/${a.id}/book/api/info`, { bearerKey: 'not-our-token' })).status).toBe(
      200,
    );
  });

  it('lets a read key read and refuses it a hold; a booking key may hold', async () => {
    const { req, signup, makeKey } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const read = await makeKey(a.token, 'Read', 'read');
    const book = await makeKey(a.token, 'Book', 'book');
    const info = await req(`/b/${a.id}/book/api/info`, { key: read.key });
    const slots = await req(
      `/b/${a.id}/book/api/availability?date=${DAY}&service=${info.json.services[0].id}`,
      { key: read.key },
    );
    expect(slots.status, slots.text).toBe(200);
    const hold = { slot_id: slots.json.slots[0].slot_id, idempotency_key: 'hold-key-1' };

    const refused = await req(`/b/${a.id}/book/api/hold`, { key: read.key, body: hold });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('insufficient_scope');
    // The slot is still free: nothing was held on the refused call.
    const held = await req(`/b/${a.id}/book/api/hold`, { key: book.key, body: hold });
    expect(held.status, held.text).toBe(200);
    expect(held.json.booking.status).toBe('held');
    // The same key as a Bearer token works too.
    const info2 = await req(`/b/${a.id}/book/api/info`, { bearerKey: book.key });
    expect(info2.status).toBe(200);
  });

  it('asks a read key to step up before it reaches the MCP endpoint', async () => {
    const { req, signup, makeKey } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const read = await makeKey(a.token, 'Read', 'read');
    const book = await makeKey(a.token, 'Book', 'book');
    const call = (key: string) =>
      req(`/b/${a.id}/mcp`, {
        key,
        headers: { accept: 'application/json, text/event-stream', host: 'localhost:3000' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
    expect((await call(read.key)).status).toBe(403);
    const ok = await call(book.key);
    expect([401, 403]).not.toContain(ok.status);
  });

  it('refuses a bad key, another business’s key and a revoked key with 401', async () => {
    const { req, signup, makeKey } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const b = await signup('Beta Frisør', 'b@example.com');
    const mine = await makeKey(a.token, 'Mine', 'read');
    const theirs = await makeKey(b.token, 'Theirs', 'read');

    const bad = await req(`/b/${a.id}/book/api/info`, {
      key: 'obk_aaaaaaaaaaaa_' + 'x'.repeat(43),
    });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe('invalid_api_key');
    // Not even a valid key opens another business.
    expect((await req(`/b/${a.id}/book/api/info`, { key: theirs.key })).status).toBe(401);
    expect((await req(`/b/${b.id}/book/api/info`, { key: theirs.key })).status).toBe(200);

    expect((await req(`/b/${a.id}/book/api/info`, { key: mine.key })).status).toBe(200);
    expect(
      (await req(`/studio/api/api-keys/${mine.id}`, { token: a.token, method: 'DELETE' })).status,
    ).toBe(200);
    const revoked = await req(`/b/${a.id}/book/api/info`, { key: mine.key });
    expect(revoked.status).toBe(401);
    // Revoking again, or someone else's key, finds nothing.
    expect(
      (await req(`/studio/api/api-keys/${mine.id}`, { token: a.token, method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (await req(`/studio/api/api-keys/${theirs.id}`, { token: a.token, method: 'DELETE' })).status,
    ).toBe(404);
    expect((await req(`/b/${b.id}/book/api/info`, { key: theirs.key })).status).toBe(200);
  });

  it('is not a way into Studio, and Studio needs the owner’s session to manage keys', async () => {
    const { req, signup, makeKey } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const book = await makeKey(a.token, 'Book', 'book');
    expect((await req('/studio/api/settings', { token: book.key })).status).toBe(401);
    expect((await req('/studio/api/settings', { key: book.key })).status).toBe(401);
    expect((await req('/studio/api/api-keys')).status).toBe(401);
    expect((await req('/studio/api/api-keys', { body: { name: 'x', scope: 'book' } })).status).toBe(
      401,
    );
  });

  it('limits each key on its own', async () => {
    const { req, signup, makeKey } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const busy = await makeKey(a.token, 'Busy', 'read');
    const quiet = await makeKey(a.token, 'Quiet', 'read');
    let last = 200;
    for (let i = 0; i < 301; i++)
      last = (await req(`/b/${a.id}/book/api/info`, { key: busy.key })).status;
    expect(last).toBe(429);
    expect((await req(`/b/${a.id}/book/api/info`, { key: quiet.key })).status).toBe(200);
    // Visitors without a key are not counted against it.
    expect((await req(`/b/${a.id}/book/api/info`)).status).toBe(200);
  });

  it('checks the name and scope, and caps the active keys', async () => {
    const { req, signup, makeKey } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const bad = (body: unknown) => req('/studio/api/api-keys', { token: a.token, body });
    expect((await bad({ name: '', scope: 'read' })).status).toBe(400);
    expect((await bad({ name: 'x'.repeat(61), scope: 'read' })).status).toBe(400);
    expect((await bad({ name: 'ok', scope: 'admin' })).status).toBe(400);
    const first = await makeKey(a.token, 'k0', 'read');
    for (let i = 1; i < 10; i++) await makeKey(a.token, `k${i}`, 'read');
    expect((await bad({ name: 'eleventh', scope: 'read' })).status).toBe(400);
    // Revoking one frees a place.
    await req(`/studio/api/api-keys/${first.id}`, { token: a.token, method: 'DELETE' });
    expect((await bad({ name: 'eleventh', scope: 'read' })).status).toBe(200);
  });

  it('removes the keys with the account', async () => {
    const { req, signup, makeKey, apiKeys } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const b = await signup('Beta Frisør', 'b@example.com');
    const mine = await makeKey(a.token, 'Mine', 'read');
    const theirs = await makeKey(b.token, 'Theirs', 'read');
    const del = await req('/studio/api/account/delete', {
      token: a.token,
      body: { password: 'correct horse' },
    });
    expect(del.status, del.text).toBe(200);
    expect(await apiKeys.get(mine.id)).toBeUndefined();
    expect(await apiKeys.get(theirs.id)).toBeDefined();
  });

  it('lets a browser send the key: the preflight allows the header', async () => {
    const { req, signup } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const pre = await req(`/b/${a.id}/book/api/hold`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://my-site.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-openbooking-key',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-openbooking-key');
  });

  it('tells Studio where the keys are', async () => {
    const { req, signup } = setup();
    const a = await signup('Alfa Frisør', 'a@example.com');
    const settings = await req('/studio/api/settings', { token: a.token });
    expect(settings.json.api_keys).toEqual({ path: '/api-keys' });
  });
});
