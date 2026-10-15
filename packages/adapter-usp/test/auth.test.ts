/**
 * Platform authentication over REST with real keys: Ed25519 DPoP proofs, booking-scoped
 * credentials bound to the caller's key, replay defence and the key-to-profile binding.
 */
import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import {
  buildUspProfile,
  createPopAuthenticator,
  createUspRouter,
  MemoryUspState,
  USP_AUTHORITY,
} from '../src';
import { b64, ORIGIN, platform, type Platform, type World } from './platform';
import { problemErrors, profileErrors } from './spec';

const NOW = '2026-10-01T08:00:00Z';
const FAR = '2026-10-16';
const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;

function setup(options: { checkProfile?: (uri: string) => Promise<void> } = {}) {
  const clock = new ManualClock(NOW);
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const state = new MemoryUspState(() => clock.now().getTime());
  const auth = createPopAuthenticator({
    baseUrl: ORIGIN,
    state,
    clock,
    ...(options.checkProfile ? { checkProfile: options.checkProfile } : {}),
  });
  const app = new Hono().route(
    '/usp',
    createUspRouter({
      service,
      baseUrl: ORIGIN,
      consent: 'commit',
      auth,
      state,
    }),
  );
  return { clock, service, state, auth, app };
}

async function firstSlot(w: World, date = FAR) {
  const res = await w.app.request('/usp/availability/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: 'haircut',
      start_date: date,
      end_date: date,
      resource_id: 'maria',
      limit: 3,
    }),
  });
  return ((await res.json()) as any).slots[0] as { id: string };
}

const book = (p: Platform, slot: { id: string }, key = `key-${Math.random()}`) =>
  p.call(
    'POST',
    '/bookings',
    { service_id: 'haircut', slot_id: slot.id, buyer: BUYER },
    { headers: { 'idempotency-key': key.padEnd(8, '0') } },
  );

describe('who is calling', () => {
  it('needs a USP-Agent profile and a proof on every privileged request', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const body = { slot_id: slot.id, service_id: 'haircut' };

    const noAgent = await p.call('POST', '/availability/holds', body, { noAgent: true });
    expect(noAgent.status).toBe(401);
    expect(noAgent.json.type).toBe(type('authentication-required'));
    expect(noAgent.headers.get('www-authenticate')).toContain('DPoP');

    const noProof = await p.call('POST', '/availability/holds', body, { noProof: true });
    expect(noProof.status).toBe(401);
    expect(noProof.json.type).toBe(type('pop-proof-missing'));
    expect(problemErrors(noProof.json)).toEqual([]);
    expect(noProof.headers.get('www-authenticate')).toContain('EdDSA');
  });

  it('refuses a malformed profile URL', async () => {
    const w = setup();
    const slot = await firstSlot(w);
    for (const bad of ['http://agent.example/p.json', 'not a url', 'https://u:p@agent.example/p']) {
      const p = await platform(w, bad);
      const res = await p.call('POST', '/availability/holds', {
        slot_id: slot.id,
        service_id: 'haircut',
      });
      expect(res.status).toBe(400);
      expect(res.json.type).toBe(type('invalid-profile-url'));
    }
  });

  it('takes a hold from a platform that proves its key, and identifies it by that key', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const res = await p.call('POST', '/availability/holds', {
      slot_id: slot.id,
      service_id: 'haircut',
    });
    expect(res.status).toBe(201);
    // Whoever holds the key owns the hold: the engine-side owner is the key's thumbprint.
    expect(await w.state.ownerOf(res.json.hold.id.replace('hold_', ''))).toBe(p.jkt);
  });

  it('advertises its mechanisms in the profile', () => {
    const w = setup();
    const profile = buildUspProfile({
      baseUrl: ORIGIN,
      business: { name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
      bookings: { mechanisms: w.auth.mechanisms },
    });
    expect(profileErrors(profile)).toEqual([]);
    expect(profile.authorization!.accepted_mechanisms).toEqual([
      'platform_key_pop',
      'booking_scoped_credential',
    ]);
  });
});

describe('proofs', () => {
  it('rejects a proof that has been used, for reads as well as writes', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const created = await book(p, slot);
    const id = created.json.booking.id as string;
    const cred = created.json.booking_scoped_credential.value as string;

    const once = await p.proof('GET', `/usp/bookings/${id}`, {
      credential: cred,
      jti: 'fixed-jti-1',
    });
    const send = () =>
      w.app.request(`/usp/bookings/${id}`, {
        headers: {
          'usp-agent': 'profile="https://agent.example/profile.json"',
          authorization: `DPoP ${cred}`,
          dpop: once,
        },
      });
    expect((await send()).status).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).type).toBe(type('pop-proof-replayed'));
  });

  it('rejects a proof for another URL or method', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const body = { slot_id: slot.id, service_id: 'haircut' };
    const url = await p.call('POST', '/availability/holds', body, {
      proofOptions: { htu: 'https://other-business.example/usp/availability/holds' },
    });
    expect(url.status).toBe(401);
    expect(url.json.type).toBe(type('pop-proof-invalid'));
    const method = await p.call('POST', '/availability/holds', body, {
      proofOptions: { htm: 'GET' },
    });
    expect(method.json.type).toBe(type('pop-proof-invalid'));
    // Nothing was held by either bad request.
    expect((await p.call('POST', '/availability/holds', body)).status).toBe(201);
  });

  it('rejects a stale proof, and one from the future', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const body = { slot_id: slot.id, service_id: 'haircut' };
    const now = Math.floor(w.clock.now().getTime() / 1000);
    for (const iat of [now - 120, now + 120]) {
      const res = await p.call('POST', '/availability/holds', body, { proofOptions: { iat } });
      expect(res.status).toBe(401);
      expect(res.json.type).toBe(type('pop-proof-invalid'));
    }
  });

  it('rejects a proof that carries private key material', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const withPrivate = { ...p.jwk, d: 'AAAA' };
    const res = await p.call(
      'POST',
      '/availability/holds',
      { slot_id: slot.id, service_id: 'haircut' },
      { proofOptions: { jwk: withPrivate as typeof p.jwk } },
    );
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-proof-invalid'));
  });
});

describe('booking-scoped credentials', () => {
  it('are issued bound to the caller key, and are well formed', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const res = await book(p, slot);
    expect(res.status).toBe(201);
    const cred = res.json.booking_scoped_credential;
    expect(cred.value).toMatch(/^bsc_/);
    expect(cred.value.length).toBeGreaterThanOrEqual(26);
    expect(cred.cnf).toEqual({ jkt: p.jkt });
    expect(cred.scope).toEqual([`booking:${res.json.booking.id}`]);
    expect(Date.parse(cred.expires_at)).toBeGreaterThan(Date.parse(res.json.booking.slot.end));
    // Only a hash is kept: the value itself is not recoverable from the store.
    const stored = await w.state.findCredential(b64(cred.value));
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(cred.value);
  });

  it('work on their booking with a proof from the same key', async () => {
    const w = setup();
    const p = await platform(w);
    const created = await book(p, await firstSlot(w));
    const id = created.json.booking.id as string;
    const cred = created.json.booking_scoped_credential.value as string;
    const read = await p.call('GET', `/bookings/${id}`, undefined, { credential: cred });
    expect(read.status).toBe(200);
    expect(read.json.booking.id).toBe(id);
    // A credential is only ever issued on creation, never on a read.
    expect(read.json.booking_scoped_credential).toBeUndefined();
  });

  it('are never a bearer token: no proof, or the Bearer scheme, is refused', async () => {
    const w = setup();
    const p = await platform(w);
    const created = await book(p, await firstSlot(w));
    const id = created.json.booking.id as string;
    const cred = created.json.booking_scoped_credential.value as string;

    const noProof = await p.call('GET', `/bookings/${id}`, undefined, {
      credential: cred,
      noProof: true,
    });
    expect(noProof.status).toBe(401);
    expect(noProof.json.type).toBe(type('pop-proof-missing'));

    const bearer = await p.call('GET', `/bookings/${id}`, undefined, {
      credential: cred,
      scheme: 'Bearer',
      noProof: true,
    });
    expect(bearer.status).toBe(401);
  });

  it('cannot be used with another key, even a valid one (a stolen credential)', async () => {
    const w = setup();
    const owner = await platform(w);
    const thief = await platform(w, 'https://thief.example/profile.json');
    const created = await book(owner, await firstSlot(w));
    const id = created.json.booking.id as string;
    const cred = created.json.booking_scoped_credential.value as string;

    const res = await thief.call('GET', `/bookings/${id}`, undefined, { credential: cred });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-key-mismatch'));
  });

  it('need a proof that covers them (ath)', async () => {
    const w = setup();
    const p = await platform(w);
    const created = await book(p, await firstSlot(w));
    const id = created.json.booking.id as string;
    const cred = created.json.booking_scoped_credential.value as string;
    const res = await p.call('GET', `/bookings/${id}`, undefined, {
      credential: cred,
      proofOptions: { ath: b64('bsc_a-different-credential') },
    });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-proof-invalid'));
  });

  it('only reach the booking they were issued for', async () => {
    const w = setup();
    const p = await platform(w);
    const a = await book(p, await firstSlot(w));
    const b = await book(p, await firstSlot(w, '2026-10-17'));
    const credA = a.json.booking_scoped_credential.value as string;
    const wrong = await p.call('GET', `/bookings/${b.json.booking.id}`, undefined, {
      credential: credA,
    });
    expect(wrong.status).toBe(404);
    expect(wrong.json.type).toBe(type('booking-not-found'));
  });

  it('expire, and an expired one is refused', async () => {
    const w = setup();
    const p = await platform(w);
    const created = await book(p, await firstSlot(w));
    const id = created.json.booking.id as string;
    const cred = created.json.booking_scoped_credential.value as string;
    w.clock.advance(60 * 24 * 3600_000); // two months on, long after the booking and the grace
    const res = await p.call('GET', `/bookings/${id}`, undefined, { credential: cred });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('authentication-required'));
  });

  it('also come with a hold, and release it', async () => {
    const w = setup();
    const p = await platform(w);
    const slot = await firstSlot(w);
    const held = await p.call('POST', '/availability/holds', {
      slot_id: slot.id,
      service_id: 'haircut',
    });
    const cred = held.json.booking_scoped_credential;
    expect(cred.cnf.jkt).toBe(p.jkt);
    const released = await p.call('DELETE', `/availability/holds/${held.json.hold.id}`, undefined, {
      credential: cred.value,
    });
    expect(released.status).toBe(200);
    expect(released.json.hold.status).toBe('released');
  });
});

describe("platforms cannot reach each other's bookings", () => {
  it('answers 404 to a platform with a valid proof but no claim on the booking', async () => {
    const w = setup();
    const a = await platform(w, 'https://a.example/p.json');
    const b = await platform(w, 'https://b.example/p.json');
    const created = await book(a, await firstSlot(w));
    const id = created.json.booking.id as string;
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { notes: 'x' }],
    ] as const) {
      const res = await b.call(method, `/bookings/${id}`, body);
      expect(res.status).toBe(404);
    }
    expect((await b.call('POST', `/bookings/${id}/cancel`, {})).status).toBe(404);
    expect((await a.call('GET', `/bookings/${id}`)).status).toBe(200);
  });
});

describe('identity binding (trust on first use)', () => {
  it('refuses a key that later presents a different profile', async () => {
    const w = setup();
    const p = await platform(w, 'https://agent.example/one.json');
    const slot = await firstSlot(w);
    const body = { slot_id: slot.id, service_id: 'haircut' };
    expect((await p.call('POST', '/availability/holds', body)).status).toBe(201);

    const other = await p.call('POST', '/availability/holds', body, {
      headers: { 'usp-agent': 'profile="https://agent.example/two.json"' },
    });
    expect(other.status).toBe(403);
    expect(other.json.type).toBe(type('profile-not-trusted'));
  });

  it('lets different keys share one profile (many agents, one platform)', async () => {
    const w = setup();
    const shared = 'https://platform.example/profile.json';
    const one = await platform(w, shared);
    const two = await platform(w, shared);
    const s1 = await firstSlot(w);
    const s2 = await firstSlot(w, '2026-10-17');
    expect(
      (await one.call('POST', '/availability/holds', { slot_id: s1.id, service_id: 'haircut' }))
        .status,
    ).toBe(201);
    expect(
      (await two.call('POST', '/availability/holds', { slot_id: s2.id, service_id: 'haircut' }))
        .status,
    ).toBe(201);
  });

  it('refuses a platform whose profile cannot be checked, when a check is plugged in', async () => {
    const w = setup({
      checkProfile: async () => {
        throw new Error('unreachable');
      },
    });
    const p = await platform(w);
    const slot = await firstSlot(w);
    const res = await p.call('POST', '/availability/holds', {
      slot_id: slot.id,
      service_id: 'haircut',
    });
    expect(res.status).toBe(424);
    expect(res.json.type).toBe(type('profile-unreachable'));
  });
});
