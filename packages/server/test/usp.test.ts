/**
 * USP mounted in the full server, over real sockets: discovery, a booking signed with a platform's
 * own key, the customer's click on the real confirm page, and Studio seeing the new channel.
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, type BookingEvent } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp, type OpenBookingServerOptions } from '../src';

// The address the business publishes. The socket below is on a random local port, so a proof
// signed for this address (not the socket's) also shows the URL check uses the configured one.
const BASE = 'http://localhost:3000';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(extra: Partial<OpenBookingServerOptions> = {}) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const events: BookingEvent[] = [];
  const ob = createOpenBookingApp({
    provider: createDemoSalonProvider(),
    baseUrl: BASE,
    serviceOptions: { clock, onEvent: (e) => events.push(e) },
    ...extra,
  });
  const server = serve({ fetch: ob.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(ob.close, () => {
    server.close();
  });
  return { ...ob, clock, events, url };
}

const json = (res: Response) => res.json() as Promise<any>;

/** A platform with its own key, signing requests the way an assistant would. */
async function platform(
  w: { url: string; clock: ManualClock },
  profile = 'https://agents.perplexity.ai/profile.json',
  signedFor = BASE,
) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  let n = 0;
  return {
    jkt: await calculateJwkThumbprint(jwk),
    async fetch(
      method: string,
      path: string,
      body?: unknown,
      opts: { credential?: string; key?: string } = {},
    ) {
      const claims: Record<string, unknown> = {
        htm: method,
        htu: `${signedFor}${path}`,
        iat: Math.floor(w.clock.now().getTime() / 1000),
        jti: `t-${Math.random().toString(36).slice(2)}-${++n}`,
      };
      if (opts.credential) {
        claims.ath = createHash('sha256').update(opts.credential).digest('base64url');
      }
      const proof = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
        .sign(privateKey);
      return fetch(`${w.url}${path}`, {
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
    },
  };
}

const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

async function freeSlot(url: string) {
  const res = await fetch(`${url}/usp/availability/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: 'haircut',
      start_date: '2026-10-16',
      end_date: '2026-10-16',
      resource_id: 'maria',
      limit: 1,
    }),
  });
  return (await json(res)).slots[0] as { id: string };
}

describe('USP in the server', () => {
  it('is off unless asked for', async () => {
    const w = await boot();
    expect((await fetch(`${w.url}/.well-known/usp`)).status).toBe(404);
    expect((await fetch(`${w.url}/usp/services/list`, { method: 'POST' })).status).toBe(404);
    const index = await json(await fetch(`${w.url}/`, { headers: { accept: 'application/json' } }));
    expect(index.protocols.usp).toBeUndefined();
  });

  it('publishes its profile and lists itself in the index', async () => {
    const w = await boot({ usp: {} });
    const res = await fetch(`${w.url}/.well-known/usp`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const profile = await json(res);
    expect(profile.usp.services['dev.usp-protocol.services'][0].endpoint).toBe(`${BASE}/usp`);
    expect(Object.keys(profile.usp.capabilities)).toContain('dev.usp-protocol.services.bookings');
    expect(profile.authorization.privileged_operations_require_authentication).toBe(true);

    const index = await json(await fetch(`${w.url}/`, { headers: { accept: 'application/json' } }));
    expect(index.protocols.usp).toEqual({
      status: 'draft',
      profile: `${BASE}/.well-known/usp`,
      endpoint: `${BASE}/usp`,
    });
  });

  it('holds a booking for the customer, who confirms it on the real page; Studio sees the channel', async () => {
    const w = await boot({ usp: {} });
    const assistant = await platform(w);
    const slot = await freeSlot(w.url);

    const created = await assistant.fetch(
      'POST',
      '/usp/bookings',
      { service_id: 'haircut', slot_id: slot.id, buyer: BUYER },
      { key: 'server-create-0001' },
    );
    expect(created.status).toBe(201);
    const body = await json(created);
    const booking = body.booking;
    expect(booking.status).toBe('requires_action');
    expect(booking.actions[0].continue_url).toBe(`${BASE}/book/confirm/${booking.id}`);
    expect(body.booking_scoped_credential.cnf.jkt).toBe(assistant.jkt);

    // The customer opens the link on the real booking page.
    const page = await fetch(`${w.url}/book/confirm/${booking.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Nothing is booked until you confirm it here');

    // Nothing is confirmed until they press the button.
    const waiting = await json(await assistant.fetch('GET', `/usp/bookings/${booking.id}`));
    expect(waiting.booking.status).toBe('requires_action');
    const confirm = await fetch(`${w.url}/book/api/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        booking_id: booking.id,
        idempotency_key: 'customer-click-1',
        user_confirmed: true,
      }),
    });
    expect(confirm.status).toBe(200);

    const done = await json(
      await assistant.fetch('GET', `/usp/bookings/${booking.id}`, undefined, {
        credential: body.booking_scoped_credential.value,
      }),
    );
    expect(done.booking.status).toBe('confirmed');
    expect(done.booking.booking_url).toContain('/book/manage/');

    // Studio can tell which channel and which platform made the booking.
    // (The unauthenticated availability search that found the slot is a USP call too, from
    // whichever client made it; it is the bookings that name the platform.)
    const viaUsp = w.events.filter((e) => e.actor?.protocol === 'usp' && e.operation !== 'search');
    expect(viaUsp.length).toBeGreaterThan(0);
    expect(viaUsp.every((e) => e.actor?.agent === 'Perplexity')).toBe(true);
    const page2 = w.events.find((e) => e.operation === 'confirm' && e.ok);
    expect(page2?.actor?.protocol).toBe('web'); // the customer's own click, not the assistant
  });

  it('confirms at once in "commit" mode', async () => {
    const w = await boot({ usp: { consent: 'commit' } });
    const assistant = await platform(w);
    const slot = await freeSlot(w.url);
    const res = await assistant.fetch(
      'POST',
      '/usp/bookings',
      { service_id: 'haircut', slot_id: slot.id, buyer: BUYER },
      { key: 'server-create-0002' },
    );
    expect(res.status).toBe(201);
    const booking = (await json(res)).booking;
    expect(booking.status).toBe('confirmed');
    expect(booking.actions).toBeUndefined();
  });

  it('checks proofs against the published address, not the socket it arrived on', async () => {
    const w = await boot({ usp: { consent: 'commit' } });
    const slot = await freeSlot(w.url);
    const body = { slot_id: slot.id, service_id: 'haircut' };
    const wrong = await platform(w, 'https://agents.example/p.json', w.url);
    const refused = await wrong.fetch('POST', '/usp/availability/holds', body);
    expect(refused.status).toBe(401);
    const right = await platform(w, 'https://agents.example/q.json');
    expect((await right.fetch('POST', '/usp/availability/holds', body)).status).toBe(201);
  });

  it('refuses every privileged call without a proof', async () => {
    const w = await boot({ usp: { consent: 'commit' } });
    const slot = await freeSlot(w.url);
    const res = await fetch(`${w.url}/usp/availability/holds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot_id: slot.id, service_id: 'haircut' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('DPoP');
  });

  it('refuses the default consent without a booking page to confirm on', () => {
    expect(() =>
      createOpenBookingApp({
        provider: createDemoSalonProvider(),
        baseUrl: BASE,
        bookingPage: false,
        usp: {},
      }),
    ).toThrow(/booking page/);
    expect(() =>
      createOpenBookingApp({
        provider: createDemoSalonProvider(),
        baseUrl: BASE,
        bookingPage: false,
        usp: { consent: 'commit' },
      }),
    ).not.toThrow();
  });
});
