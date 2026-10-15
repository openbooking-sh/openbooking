import { serve } from '@hono/node-server';
import { createBookingPage } from '@openbooking-sh/booking-page';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  buildUspProfileFor,
  createPopAuthenticator,
  createUspRouter,
  MemoryUspState,
} from '../src';
import { problemErrors, profileErrors, responseErrors } from './spec';

// Real sockets and the real `fetch`: what a platform's HTTP client sees, headers included.
let base = '';
let close = () => {};

const ORIGIN = 'https://studio.example';
const clock = new ManualClock('2026-10-01T08:00:00Z');
const state = new MemoryUspState(() => clock.now().getTime());
const auth = createPopAuthenticator({ baseUrl: ORIGIN, state, clock });

beforeAll(async () => {
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const origin = () => base;
  // The real booking page, published at an https URL (a USP continue_url must be https) but
  // served here on the local socket.
  const page = createBookingPage({
    service,
    pageUrl: 'https://studio.example/book',
    apiBase: 'https://studio.example/book',
  });
  const app = new Hono()
    .get('/.well-known/usp', async (c) => {
      c.header('Cache-Control', 'public, max-age=300');
      return c.json(
        await buildUspProfileFor(service, {
          baseUrl: origin(),
          bookings: { mechanisms: auth.mechanisms },
        }),
      );
    })
    .route('/book', page.app)
    .route(
      '/usp',
      createUspRouter({
        service,
        baseUrl: ORIGIN,
        auth,
        state,
        continueUrl: page.confirmUrl,
        bookingUrl: page.manageUrl,
      }),
    );
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const json = (res: Response) => res.json() as Promise<any>;

const post = (path: string, body: unknown) =>
  fetch(`${base}/usp${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A platform with its own key, making signed requests the way an agent would. */
async function newPlatform(profile = 'https://agent.example/profile.json') {
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
      opts: { credential?: string; idempotencyKey?: string } = {},
    ) {
      const claims: Record<string, unknown> = {
        htm: method,
        htu: `${ORIGIN}/usp${path}`,
        iat: Math.floor(clock.now().getTime() / 1000),
        jti: `e2e-${Math.random().toString(36).slice(2)}-${++n}`,
      };
      if (opts.credential) {
        claims.ath = createHash('sha256').update(opts.credential).digest('base64url');
      }
      const proof = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk })
        .sign(privateKey);
      return fetch(`${base}/usp${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'usp-agent': `profile="${profile}"`,
          dpop: proof,
          ...(opts.credential ? { authorization: `DPoP ${opts.credential}` } : {}),
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

describe('USP over real HTTP', () => {
  it('discovers the business, then reads its catalog and availability', async () => {
    const profileRes = await fetch(`${base}/.well-known/usp`, { redirect: 'manual' });
    expect(profileRes.status).toBe(200);
    expect(profileRes.headers.get('content-type')).toContain('application/json');
    expect(profileRes.headers.get('cache-control')).toBe('public, max-age=300');
    const profile = await json(profileRes);
    expect(profileErrors(profile)).toEqual([]);
    expect(profile.usp.business).toEqual({
      name: 'Studio Nord',
      timezone: 'Europe/Oslo',
      currency: 'NOK',
    });

    // Follow the profile, as a platform does.
    const endpoint = profile.usp.services['dev.usp-protocol.services'][0].endpoint as string;
    expect(endpoint).toBe(`${base}/usp`);
    const list = await post('/services/list', {});
    const catalog = await json(list);
    expect(responseErrors('/services/list', 'post', 200, catalog)).toEqual([]);

    const first = catalog.services[0].id as string;
    const avail = await post('/availability/query', {
      service_id: first,
      start_date: '2026-10-02',
      end_date: '2026-10-02',
      limit: 10,
    });
    expect(avail.status).toBe(200);
    const body = await json(avail);
    expect(responseErrors('/availability/query', 'post', 200, body)).toEqual([]);
    expect(body.slots).toHaveLength(10);
  });

  it('reports protocol errors as problem+json with the registered type', async () => {
    const res = await fetch(`${base}/usp/services/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const problem = await json(res);
    expect(problemErrors(problem)).toEqual([]);
    expect(problem.type).toBe('https://usp-protocol.dev/errors/service-not-found');

    const wrong = await fetch(`${base}/usp/services/list`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    const feed = await fetch(`${base}/usp/services/feed`);
    expect(feed.status).toBe(501);
  });
});

describe('a USP booking confirmed on the real booking page', () => {
  it('is held for the buyer, confirmed only by their click, then visible to the platform', async () => {
    // Discover.
    const profile = await json(await fetch(`${base}/.well-known/usp`));
    expect(profileErrors(profile)).toEqual([]);
    expect(profile.authorization.accepted_mechanisms).toEqual([
      'platform_key_pop',
      'booking_scoped_credential',
    ]);
    expect(profile.usp.capabilities['dev.usp-protocol.services.bookings']).toBeDefined();

    // Find a slot, then ask to book.
    const avail = await json(
      await post('/availability/query', {
        service_id: 'haircut',
        start_date: '2026-10-16',
        end_date: '2026-10-16',
        resource_id: 'maria',
        limit: 1,
      }),
    );
    const slot = avail.slots[0];
    const assistant = await newPlatform();
    const created = await assistant.fetch(
      'POST',
      '/bookings',
      {
        service_id: 'haircut',
        slot_id: slot.id,
        buyer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      },
      { idempotencyKey: 'e2e-create-0001' },
    );
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const booking = createdBody.booking;
    // The credential comes back bound to the assistant's own key.
    const credential = createdBody.booking_scoped_credential;
    expect(credential.cnf.jkt).toBe(assistant.jkt);
    expect(booking.status).toBe('requires_action');
    const link = new URL(booking.actions[0].continue_url);
    expect(link.protocol).toBe('https:');

    // The buyer follows the link (here to the same page on the local socket).
    const pageRes = await fetch(`${base}${link.pathname}`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('Nothing is booked until you confirm it here');
    const terms = await json(await fetch(`${base}/book/api/holds/${booking.id}`));
    expect(terms.booking).toMatchObject({ status: 'held', offering: { id: 'haircut' } });

    // Looking did not book it.
    const before = await json(await assistant.fetch('GET', `/bookings/${booking.id}`));
    expect(before.booking.status).toBe('requires_action');

    // Their click is the approval.
    const confirmed = await fetch(`${base}/book/api/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        booking_id: booking.id,
        idempotency_key: 'page-confirm-e2e',
        user_confirmed: true,
      }),
    });
    expect(confirmed.status).toBe(200);

    // The platform sees the change and gets a link the customer can manage the booking with.
    // Read it back with the credential, as an assistant that kept it would.
    const after = await json(
      await assistant.fetch('GET', `/bookings/${booking.id}`, undefined, {
        credential: credential.value,
      }),
    );
    expect(responseErrors('/bookings/{booking_id}', 'get', 200, after)).toEqual([]);
    expect(after.booking.status).toBe('confirmed');
    expect(after.booking.actions).toBeUndefined();
    expect(after.booking.booking_url).toContain('/book/manage/');

    // Another platform cannot see it.
    const stranger = await (
      await newPlatform('https://other.example/profile.json')
    ).fetch('GET', `/bookings/${booking.id}`);
    expect(stranger.status).toBe(404);

    // Without a signed proof nobody gets in, however they ask.
    const anonymous = await fetch(`${base}/usp/bookings/${booking.id}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('DPoP');
  });
});
