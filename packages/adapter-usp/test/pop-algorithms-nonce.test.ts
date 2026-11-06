/**
 * `platform_key_pop` beyond the Ed25519 floor (spec 10.1.6): ES256 proofs with real P-256 keys,
 * and the nonce challenge. Over REST through the router, and over MCP through the official client.
 */
import { createHash, generateKeyPairSync, KeyObject, randomBytes, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import {
  createPopAuthenticator,
  createUsp,
  createUspRouter,
  MemoryUspState,
  USP_AUTHORITY,
  type PopAuthenticatorOptions,
} from '../src';
import { createPopNonces } from '../src/nonce';
import { connect, mcpPlatform } from './mcp-platform';
import { ORIGIN, platform, type World } from './platform';
import { stubProfiles } from './platform-profile';
import { mcpErrorDataErrors, problemErrors } from './spec';

const NOW = '2026-10-01T08:00:00Z';
const FAR = '2026-10-16';
const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;
const SECRET = 'a-shared-secret-of-32-bytes-or-so!';
const b64u = (v: string | Uint8Array) => Buffer.from(v).toString('base64url');

function setup(auth: Partial<PopAuthenticatorOptions> = {}) {
  const clock = new ManualClock(NOW);
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const state = new MemoryUspState(() => clock.now().getTime());
  const authenticator = createPopAuthenticator({ baseUrl: ORIGIN, state, clock, ...auth });
  const app = new Hono().route(
    '/usp',
    createUspRouter({ service, baseUrl: ORIGIN, consent: 'commit', auth: authenticator, state }),
  );
  return { clock, service, state, app };
}

async function firstSlot(w: World, index = 0) {
  const res = await w.app.request('/usp/availability/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: 'haircut',
      start_date: FAR,
      end_date: FAR,
      resource_id: 'maria',
      limit: 3,
    }),
  });
  return ((await res.json()) as any).slots[index] as { id: string };
}

const hold = (p: Awaited<ReturnType<typeof platform>>, slot: { id: string }, proof = {}) =>
  p.call(
    'POST',
    '/availability/holds',
    { slot_id: slot.id, service_id: 'haircut' },
    { proofOptions: proof },
  );

/** A compact JWS made by hand, for proofs that no honest library would sign. */
const forge = (header: object, claims: object, signature: Uint8Array = randomBytes(64)) =>
  `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}.${b64u(signature)}`;

describe('ES256 proofs (P-256)', () => {
  it('are refused by a business that did not turn them on, which says what it accepts', async () => {
    const w = setup();
    const p = await platform(w, undefined, undefined, 'ES256');
    const res = await hold(p, await firstSlot(w));
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-proof-invalid'));
    expect(res.headers.get('www-authenticate')).toBe('DPoP algs="EdDSA"');
  });

  it('are accepted next to EdDSA when the business lists ES256', async () => {
    const w = setup({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const es = await platform(w, undefined, undefined, 'ES256');
    const ed = await platform(w, 'https://other.example/profile.json');
    // Two platforms with two kinds of key, side by side, each on its own slot.
    expect((await hold(es, await firstSlot(w, 0))).status).toBe(201);
    expect((await hold(ed, await firstSlot(w, 1))).status).toBe(201);
  });

  it('identify the platform by the RFC 7638 thumbprint of the P-256 key', async () => {
    const w = setup({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const p = await platform(w, undefined, undefined, 'ES256');
    const res = await hold(p, await firstSlot(w));
    expect(res.status).toBe(201);
    // Computed by hand from the required members in lexicographic order, not by a library.
    const jwk = p.jwk as { crv: string; kty: string; x: string; y: string };
    const jkt = createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest('base64url');
    expect(p.jkt).toBe(jkt);
    expect(await w.state.ownerOf(res.json.hold.id.replace('hold_', ''))).toBe(jkt);
  });

  it('name every accepted algorithm in the challenge', async () => {
    const w = setup({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const p = await platform(w);
    const res = await p.call('POST', '/availability/holds', {}, { noProof: true });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('DPoP algs="EdDSA ES256"');
  });

  it('refuse a key on another curve labelled ES256, and private key material in the header', async () => {
    const w = setup({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const p = await platform(w, undefined, undefined, 'ES256');
    const slot = await firstSlot(w);
    const claims = {
      htm: 'POST',
      htu: `${ORIGIN}/usp/availability/holds`,
      iat: 1790841600,
      jti: 'x',
    };

    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({
      format: 'jwk',
    });
    const wrongCurve = await p.call(
      'POST',
      '/availability/holds',
      { slot_id: slot.id, service_id: 'haircut' },
      {
        noProof: true,
        headers: { dpop: forge({ alg: 'ES256', typ: 'dpop+jwt', jwk: p384 }, claims) },
      },
    );
    expect(wrongCurve.status).toBe(401);
    expect(wrongCurve.json.detail).toContain('P-256');

    // The platform's own proof, with the private half pasted into the header.
    const priv = KeyObject.from(p.privateKey as never).export({ format: 'jwk' });
    const leaky = await hold(p, slot, { jwk: priv as never });
    expect(leaky.status).toBe(401);
    expect(leaky.json.detail).toContain('private key material');
  });

  it('refuse a DER-encoded signature: the JWS form is fixed-width r||s', async () => {
    const w = setup({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const p = await platform(w, undefined, undefined, 'ES256');
    const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: p.jwk };
    const claims = {
      htm: 'POST',
      htu: `${ORIGIN}/usp/availability/holds`,
      iat: Math.floor(w.clock.now().getTime() / 1000),
      jti: 'der-1',
    };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    // Node signs ECDSA as DER unless told otherwise: the trap the spec warns about.
    const der = sign('sha256', Buffer.from(input), KeyObject.from(p.privateKey as never));
    const raw = sign('sha256', Buffer.from(input), {
      key: KeyObject.from(p.privateKey as never),
      dsaEncoding: 'ieee-p1363',
    });
    expect(raw.length).toBe(64);
    expect(der.length).not.toBe(64);

    const slot = await firstSlot(w);
    const body = { slot_id: slot.id, service_id: 'haircut' };
    const bad = await p.call('POST', '/availability/holds', body, {
      noProof: true,
      headers: { dpop: `${input}.${b64u(der)}` },
    });
    expect(bad.status).toBe(401);
    expect(bad.json.type).toBe(type('pop-proof-invalid'));
    const good = await p.call('POST', '/availability/holds', body, {
      noProof: true,
      headers: { dpop: `${input}.${b64u(raw)}` },
    });
    expect(good.status).toBe(201);
  });

  it('keep every other check: replay, clock skew, and a credential replayed with another key', async () => {
    const w = setup({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const a = await platform(w, undefined, undefined, 'ES256');
    const b = await platform(w, 'https://b.example/profile.json', undefined, 'ES256');
    const slot = await firstSlot(w);

    const made = await a.call(
      'POST',
      '/bookings',
      {
        service_id: 'haircut',
        slot_id: slot.id,
        buyer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      },
      { headers: { 'idempotency-key': 'es256-booking-1' } },
    );
    expect(made.status).toBe(201);
    const credential = made.json.booking_scoped_credential;
    expect(credential.cnf.jkt).toBe(a.jkt);
    const id = made.json.booking.id;

    // The holder of the credential can read it back with a proof from the SAME key...
    expect(
      (await a.call('GET', `/bookings/${id}`, undefined, { credential: credential.value })).status,
    ).toBe(200);
    // ...and a genuine proof from another key is turned away: the credential is sender-constrained.
    const stolen = await b.call('GET', `/bookings/${id}`, undefined, {
      credential: credential.value,
    });
    expect(stolen.status).toBe(401);
    expect(stolen.json.type).toBe(type('pop-key-mismatch'));

    // The same proof twice is a replay; one from two minutes ago is outside the skew.
    const seen = await a.proof('GET', `/usp/bookings/${id}`, {
      credential: credential.value,
      jti: 'once',
    });
    const headers = {
      authorization: `DPoP ${credential.value}`,
      dpop: seen,
      'usp-agent': 'profile="https://agent.example/profile.json"',
    };
    expect((await w.app.request(`/usp/bookings/${id}`, { headers })).status).toBe(200);
    const again = await w.app.request(`/usp/bookings/${id}`, { headers });
    expect(again.status).toBe(401);
    expect(((await again.json()) as any).type).toBe(type('pop-proof-replayed'));
    const old = await a.call('GET', `/bookings/${id}`, undefined, {
      credential: credential.value,
      proofOptions: { iat: Math.floor(w.clock.now().getTime() / 1000) - 120 },
    });
    expect(old.status).toBe(401);
    expect(old.json.detail).toContain('too old');
  });

  it('cannot be the only algorithm: EdDSA is the spec floor', () => {
    expect(() => setup({ proofAlgorithms: ['ES256'] })).toThrow(/EdDSA/);
  });
});

describe('the nonce challenge', () => {
  const slotAndPlatform = async (w: ReturnType<typeof setup>, alg?: 'EdDSA' | 'ES256') => ({
    p: await platform(w, undefined, undefined, alg),
    slot: await firstSlot(w),
  });

  it('answers a proof without a nonce with one, in the RFC 9449 header and the body', async () => {
    const w = setup({ nonces: { secret: SECRET } });
    const { p, slot } = await slotAndPlatform(w);
    const res = await hold(p, slot);
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('proof-nonce-required'));
    expect(problemErrors(res.json)).toEqual([]);
    const nonce = res.headers.get('dpop-nonce');
    expect(nonce).toMatch(/^\d+\.[A-Za-z0-9_-]{22}$/);
    expect(res.json.nonce).toBe(nonce);
    expect(res.headers.get('www-authenticate')).toBe('DPoP error="use_dpop_nonce", algs="EdDSA"');
  });

  it('accepts the retry that carries it, and does not burn the jti of the challenged proof', async () => {
    const w = setup({ nonces: { secret: SECRET } });
    const { p, slot } = await slotAndPlatform(w);
    const challenged = await hold(p, slot, { jti: 'same-jti' });
    const nonce = challenged.headers.get('dpop-nonce')!;
    const retry = await hold(p, slot, { jti: 'same-jti', nonce });
    expect(retry.status).toBe(201);
    // The jti is used now.
    const replay = await hold(p, slot, { jti: 'same-jti', nonce });
    expect(replay.json.type).toBe(type('pop-proof-replayed'));
  });

  it('works with ES256 proofs too', async () => {
    const w = setup({ nonces: { secret: SECRET }, proofAlgorithms: ['EdDSA', 'ES256'] });
    const { p, slot } = await slotAndPlatform(w, 'ES256');
    const nonce = (await hold(p, slot)).headers.get('dpop-nonce')!;
    expect((await hold(p, slot, { nonce })).status).toBe(201);
  });

  it("gives each key its own nonce: one platform cannot use another one's", async () => {
    const w = setup({ nonces: { secret: SECRET } });
    const a = await platform(w);
    const b = await platform(w, 'https://b.example/profile.json');
    const slot = await firstSlot(w);
    const nonceForA = (await hold(a, slot)).headers.get('dpop-nonce')!;
    const withA = await hold(b, slot, { nonce: nonceForA });
    expect(withA.status).toBe(401);
    expect(withA.json.type).toBe(type('proof-nonce-required'));
    expect(withA.headers.get('dpop-nonce')).not.toBe(nonceForA);
  });

  it('refuses a tampered or made-up nonce', async () => {
    const w = setup({ nonces: { secret: SECRET } });
    const { p, slot } = await slotAndPlatform(w);
    const good = (await hold(p, slot)).headers.get('dpop-nonce')!;
    const flipped = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    for (const nonce of [flipped, 'nonsense', '123.' + 'x'.repeat(22)]) {
      const res = await hold(p, slot, { nonce });
      expect(res.status).toBe(401);
      expect(res.json.type).toBe(type('proof-nonce-required'));
    }
  });

  it('lives for one to two windows: fine one window later, refused two windows later', async () => {
    const w = setup({ nonces: { secret: SECRET, windowSeconds: 300 } });
    const { p, slot } = await slotAndPlatform(w);
    const nonce = (await hold(p, slot)).headers.get('dpop-nonce')!;

    w.clock.advanceSeconds(400); // the next window
    expect((await hold(p, slot, { nonce })).status).toBe(201);

    const w2 = setup({ nonces: { secret: SECRET, windowSeconds: 300 } });
    const second = await slotAndPlatform(w2);
    const old = (await hold(second.p, second.slot)).headers.get('dpop-nonce')!;
    w2.clock.advanceSeconds(700); // two windows on
    const stale = await hold(second.p, second.slot, { nonce: old });
    expect(stale.status).toBe(401);
    expect(stale.json.type).toBe(type('proof-nonce-required'));
    // The fresh nonce in that answer works.
    const fresh = stale.headers.get('dpop-nonce')!;
    expect((await hold(second.p, second.slot, { nonce: fresh })).status).toBe(201);
  });

  it('is ignored when the business does not require one', async () => {
    const w = setup();
    const { p, slot } = await slotAndPlatform(w);
    expect((await hold(p, slot, { nonce: 'whatever' })).status).toBe(201);
  });

  it('is the same on every instance that shares the secret, and different for another secret', async () => {
    const at = new Date(NOW);
    const one = createPopNonces({ secret: SECRET });
    const two = createPopNonces({ secret: SECRET });
    const other = createPopNonces({ secret: 'another-secret-of-32-bytes-or-so' });
    const nonce = one.issue('jkt-a', at);
    expect(two.check(nonce, 'jkt-a', at)).toBe(true);
    expect(other.check(nonce, 'jkt-a', at)).toBe(false);
    expect(two.check(nonce, 'jkt-b', at)).toBe(false);
    expect(() => createPopNonces({ secret: 'short' })).toThrow(/16 bytes/);
  });
});

describe('over MCP', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function setupMcp(
    platformAuth: NonNullable<Parameters<typeof createUsp>[0]['platformAuth']>,
  ) {
    const clock = new ManualClock(NOW);
    const service = new BookingService({ provider: createDemoSalonProvider(), clock });
    const usp = createUsp({
      service,
      baseUrl: ORIGIN,
      platformProfiles: stubProfiles().fetcher,
      consent: 'commit',
      mcp: true,
      platformAuth,
    });
    const app = new Hono().route(usp.path, usp.router);
    const world = {
      clock,
      fetch: (r: Request) => Promise.resolve(app.fetch(r)),
      url: `${ORIGIN}/usp/mcp`,
    };
    const client = await connect(world);
    cleanups.push(async () => {
      await client.close();
      await usp.close();
    });
    return {
      client,
      platform: (alg?: 'EdDSA' | 'ES256') => mcpPlatform(world, client, undefined, alg),
    };
  }

  const holdArgs = async (p: Awaited<ReturnType<typeof mcpPlatform>>) => {
    const slots = await p.pub('usp_availability_query', {
      service_id: 'haircut',
      start_date: FAR,
      end_date: FAR,
      resource_id: 'maria',
    });
    return { slot_id: slots.result.structuredContent.slots[0].id, service_id: 'haircut' };
  };

  it('accept an ES256 proof when the business lists ES256, and refuse it otherwise', async () => {
    const on = await setupMcp({ proofAlgorithms: ['EdDSA', 'ES256'] });
    const p = await on.platform('ES256');
    const res = await p.call('usp_availability_hold', await holdArgs(p));
    expect(res.error).toBeUndefined();
    expect(res.result.isError).not.toBe(true);

    const off = await setupMcp({});
    const q = await off.platform('ES256');
    const refused = await q.call('usp_availability_hold', await holdArgs(q));
    expect(refused.error.data.code).toBe('pop_proof_invalid');
  });

  it('challenge for a nonce in data.nonce, and accept the retry', async () => {
    const w = await setupMcp({ nonces: { secret: SECRET } });
    const p = await w.platform();
    const args = await holdArgs(p);
    const first = await p.call('usp_availability_hold', args);
    expect(first.error.data.code).toBe('proof_nonce_required');
    expect(first.error.code).toBe(-32001);
    expect(mcpErrorDataErrors(first.error.data)).toEqual([]);
    expect(first.error.data.nonce).toMatch(/^\d+\.[A-Za-z0-9_-]{22}$/);

    const retry = await p.call('usp_availability_hold', args, {
      proof: { nonce: first.error.data.nonce },
    });
    expect(retry.error).toBeUndefined();
    expect(retry.result.isError).not.toBe(true);
  });
});
