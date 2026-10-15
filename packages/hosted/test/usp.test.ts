/**
 * USP on hosted: each business turns it on in Studio and chooses how assistants book. Requests
 * reach a business at /b/<id>/... and hosted strips that prefix before the business sees them, so
 * these tests sign the PUBLIC URL, exactly as a platform would, and check the whole path.
 */
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@openbooking-sh/core';
import { USP, USP_VERSION, type ProfileFetcher } from '@openbooking-sh/adapter-usp';
import { createHostedApp, MemoryBusinessStore } from '../src';

const BASE = 'https://app.example';
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';
const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

/** Platform profiles without a network: every platform can use everything. */
const fetched: string[] = [];
const profiles: ProfileFetcher = async (uri) => {
  fetched.push(uri);
  const entry = [{ version: USP_VERSION }];
  return {
    usp: {
      version: USP_VERSION,
      capabilities: { [USP.catalog]: entry, [USP.availability]: entry, [USP.bookings]: entry },
    },
  };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const clock = new ManualClock(NOW);
  const businesses = new MemoryBusinessStore();
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock,
    businesses,
    uspPlatformProfiles: profiles,
  });
  cleanups.push(hosted.close);
  const req = async (
    path: string,
    opts: { method?: string; body?: unknown; token?: string } = {},
  ) => {
    const res = await hosted.app.request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
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
    return { status: res.status, headers: res.headers, json, text };
  };
  return { clock, businesses, hosted, req };
}
type World = ReturnType<typeof setup>;

const signup = async (w: World, name: string, email: string) =>
  (
    await w.req('/api/signup', {
      body: {
        business_name: name,
        your_name: 'Maria Berg',
        email,
        password: 'correct horse',
        category: 'hair_salon',
        city: 'Oslo',
      },
    })
  ).json.token as string;

/** Set how assistants may book, through Studio, as an owner would. */
async function setUsp(w: World, token: string, usp: 'off' | 'confirm' | 'instant') {
  const { settings } = (await w.req('/studio/api/settings', { token })).json;
  settings.assistants = { usp };
  const saved = await w.req('/studio/api/settings', { method: 'PUT', body: settings, token });
  expect(saved.status, saved.text).toBe(200);
}

/** A platform with its own key, signing the public URL of each call. */
async function platform(w: World, profile = 'https://agents.example/profile.json') {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  let n = 0;
  return {
    jkt: await calculateJwkThumbprint(jwk),
    /** `path` is what the platform calls, e.g. /b/studio-nord/usp/bookings. */
    async call(
      method: string,
      path: string,
      body?: unknown,
      opts: { key?: string; credential?: string; signedFor?: string } = {},
    ) {
      const claims: Record<string, unknown> = {
        htm: method,
        htu: `${BASE}${opts.signedFor ?? path}`,
        iat: Math.floor(w.clock.now().getTime() / 1000),
        jti: `h-${Math.random().toString(36).slice(2)}-${++n}`,
      };
      if (opts.credential) {
        claims.ath = createHash('sha256').update(opts.credential).digest('base64url');
      }
      const proof = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
        .sign(privateKey);
      const res = await w.hosted.app.request(`${BASE}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'usp-agent': `profile="${profile}"`,
          dpop: proof,
          ...(opts.credential ? { authorization: `DPoP ${opts.credential}` } : {}),
          ...(opts.key ? { 'idempotency-key': opts.key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, headers: res.headers, json: (await res.json()) as any };
    },
  };
}

async function freeSlot(w: World, id: string) {
  const res = await w.req(`/b/${id}/usp/availability/query`, {
    body: { service_id: 'haircut', start_date: DAY, end_date: DAY, limit: 1 },
  });
  return res.json.slots[0] as { id: string };
}

const book = (
  p: Awaited<ReturnType<typeof platform>>,
  id: string,
  slot: { id: string },
  key: string,
) =>
  p.call(
    'POST',
    `/b/${id}/usp/bookings`,
    { service_id: 'haircut', slot_id: slot.id, buyer: BUYER },
    { key },
  );

describe('a business that has not turned USP on', () => {
  it('does not offer it', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    expect((await w.req('/b/studio-nord/.well-known/usp')).status).toBe(404);
    expect((await w.req('/b/studio-nord/usp/services/list', { body: {} })).status).toBe(404);
    const view = (await w.req('/studio/api/settings', { token })).json;
    expect(view.settings.assistants).toEqual({ usp: 'off' });
    expect(view.links.map((l: any) => l.label)).not.toContain('USP profile');
  });
});

describe('a business that turns USP on', () => {
  it('publishes its profile under its own address, and Studio links to it', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    await setUsp(w, token, 'confirm');
    const res = await w.req('/b/studio-nord/.well-known/usp');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.json.usp.business.name).toBe('Studio Nord');
    expect(res.json.usp.services['dev.usp-protocol.services'][0].endpoint).toBe(
      `${BASE}/b/studio-nord/usp`,
    );
    const view = (await w.req('/studio/api/settings', { token })).json;
    expect(view.links).toContainEqual(
      expect.objectContaining({
        label: 'USP profile',
        url: `${BASE}/b/studio-nord/.well-known/usp`,
      }),
    );
  });

  it('takes a booking signed for the public address, held until the customer confirms on the page', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    await setUsp(w, token, 'confirm');
    const assistant = await platform(w);
    const slot = await freeSlot(w, 'studio-nord');

    const created = await book(assistant, 'studio-nord', slot, 'hosted-create-0001');
    expect(created.status).toBe(201);
    const booking = created.json.booking;
    expect(booking.status).toBe('requires_action');
    expect(booking.actions[0].continue_url).toBe(
      `${BASE}/b/studio-nord/book/confirm/${booking.id}`,
    );
    expect(booking.service_id).toBe('haircut');
    // Hosted fetched the platform's own profile through its shared fetcher.
    expect(fetched).toContain('https://agents.example/profile.json');

    // The link works on the hosted booking page, and opening it books nothing.
    const page = await w.req(`/b/studio-nord/book/confirm/${booking.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Nothing is booked until you confirm it here');
    const waiting = await assistant.call('GET', `/b/studio-nord/usp/bookings/${booking.id}`);
    expect(waiting.json.booking.status).toBe('requires_action');

    // The customer's click is the approval.
    const confirmed = await w.req('/b/studio-nord/book/api/confirm', {
      body: { booking_id: booking.id, idempotency_key: 'customer-click', user_confirmed: true },
    });
    expect(confirmed.status, confirmed.text).toBe(200);

    const done = await assistant.call(
      'GET',
      `/b/studio-nord/usp/bookings/${booking.id}`,
      undefined,
      {
        credential: created.json.booking_scoped_credential.value,
      },
    );
    expect(done.json.booking.status).toBe('confirmed');
    expect(done.json.booking.booking_url).toContain('/b/studio-nord/book/manage/');
  });

  it('confirms at once when the owner chose "immediately"', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    await setUsp(w, token, 'instant');
    const assistant = await platform(w);
    const created = await book(
      assistant,
      'studio-nord',
      await freeSlot(w, 'studio-nord'),
      'hosted-create-0002',
    );
    expect(created.status).toBe(201);
    expect(created.json.booking.status).toBe('confirmed');
  });

  it('stops offering it again when the owner turns it off', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    await setUsp(w, token, 'confirm');
    expect((await w.req('/b/studio-nord/.well-known/usp')).status).toBe(200);
    await setUsp(w, token, 'off');
    expect((await w.req('/b/studio-nord/.well-known/usp')).status).toBe(404);
    expect((await w.req('/b/studio-nord/usp/services/list', { body: {} })).status).toBe(404);
  });

  it('keeps what it knows when the owner changes the setting (the app is rebuilt)', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    await setUsp(w, token, 'confirm');
    const assistant = await platform(w);
    const created = await book(
      assistant,
      'studio-nord',
      await freeSlot(w, 'studio-nord'),
      'hosted-create-0003',
    );
    const id = created.json.booking.id as string;
    const credential = created.json.booking_scoped_credential.value as string;

    await setUsp(w, token, 'instant'); // rebuilds the business's app
    const read = await assistant.call('GET', `/b/studio-nord/usp/bookings/${id}`, undefined, {
      credential,
    });
    expect(read.status).toBe(200);
    expect(read.json.booking.id).toBe(id);
  });
});

describe('several businesses on one deployment', () => {
  it("keep a platform's idempotency keys apart", async () => {
    const w = setup();
    const a = await signup(w, 'Studio Nord', 'a@example.com');
    const b = await signup(w, 'Salon Vest', 'b@example.com');
    await setUsp(w, a, 'instant');
    await setUsp(w, b, 'instant');
    const assistant = await platform(w);
    const slotA = await freeSlot(w, 'studio-nord');
    const slotB = await freeSlot(w, 'salon-vest');
    // One Idempotency-Key, two different requests at two different businesses: not a conflict.
    expect((await book(assistant, 'studio-nord', slotA, 'same-key-0001')).status).toBe(201);
    expect((await book(assistant, 'salon-vest', slotB, 'same-key-0001')).status).toBe(201);
  });

  it('refuse a proof signed for another business', async () => {
    const w = setup();
    const a = await signup(w, 'Studio Nord', 'a@example.com');
    const b = await signup(w, 'Salon Vest', 'b@example.com');
    await setUsp(w, a, 'instant');
    await setUsp(w, b, 'instant');
    const assistant = await platform(w);
    const slotB = await freeSlot(w, 'salon-vest');
    const res = await assistant.call(
      'POST',
      '/b/salon-vest/usp/availability/holds',
      { slot_id: slotB.id, service_id: 'haircut' },
      { signedFor: '/b/studio-nord/usp/availability/holds' },
    );
    expect(res.status).toBe(401);
    expect(res.json.type).toBe('https://usp-protocol.dev/errors/pop-proof-invalid');
  });

  it('give each business its own business id in USP', async () => {
    const w = setup();
    const a = await signup(w, 'Studio Nord', 'a@example.com');
    const b = await signup(w, 'Salon Vest', 'b@example.com');
    await setUsp(w, a, 'confirm');
    await setUsp(w, b, 'confirm');
    const idOf = async (id: string) =>
      (await w.req(`/b/${id}/usp/services/haircut`)).json.service.business_id;
    expect(await idOf('studio-nord')).toBe('studio-nord');
    expect(await idOf('salon-vest')).toBe('salon-vest');
  });
});

describe('businesses saved before this setting existed', () => {
  it('count as off, and keep working', async () => {
    const w = setup();
    const token = await signup(w, 'Studio Nord', 'owner@example.com');
    // An old record: no `assistants` block at all.
    await w.businesses.update('studio-nord', (b) => {
      const settings: any = { ...b.settings };
      delete settings.assistants;
      return { ...b, settings, version: b.version + 1 };
    });

    expect((await w.req('/b/studio-nord/.well-known/usp')).status).toBe(404);
    expect((await w.req('/b/studio-nord/book/api/info')).status).toBe(200);
    const view = await w.req('/studio/api/settings', { token });
    expect(view.status).toBe(200);
    expect(view.json.settings.assistants).toBeUndefined();

    // Saving from an older Studio page, which sends no such block, must still work and mean off.
    const { settings } = view.json;
    const saved = await w.req('/studio/api/settings', { method: 'PUT', body: settings, token });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.settings.assistants).toEqual({ usp: 'off' });
  });
});
