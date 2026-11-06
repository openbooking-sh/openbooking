/**
 * `http_message_signature` (spec 9.1.4 and 10.1.6): a platform signs its requests with a P-256 key
 * it publishes in its own profile. The verifier is checked three ways:
 *  - against a signature published in RFC 9421 itself (a real ES256 request signature);
 *  - end to end through the router, with real keys, real signatures and every part of a request
 *    tampered with in turn;
 *  - for the things the spec makes mandatory: covered components, fixed-width signatures,
 *    Content-Digest, no fallback to another mechanism.
 */
import { createHash } from 'node:crypto';
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
  type HttpSignatureOptions,
  type PlatformProfile,
  type ProfileFetcher,
} from '../src';
import {
  componentValue,
  readSignature,
  resolveSigningKey,
  signatureBase,
  verifyEs256,
} from '../src/http-signature';
import { parseDictionary, serializeInnerList, type InnerList } from '../src/sfv';
import { ORIGIN, platform } from './platform';
import { signingPlatform, type SignedCall, type SigningPlatform } from './signing-platform';
import { problemErrors, profileErrors } from './spec';

const NOW = '2026-10-01T08:00:00Z';
const FAR = '2026-10-16';
const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;
const AGENT = 'https://agent.example/profile.json';

// ---------------------------------------------------------------------------
// RFC 9421: a published ES256 request signature
// ---------------------------------------------------------------------------

describe('against the signature published in RFC 9421 (section 4.3, test-key-ecc-p256)', () => {
  // The public half of the RFC's test-key-ecc-p256 (Appendix B.1.3), as a profile would publish it.
  const rfcKey = {
    kty: 'EC',
    crv: 'P-256',
    kid: 'test-key-ecc-p256',
    x: 'qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA',
    y: 'Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0',
  };
  const DIGEST =
    'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:';
  const INPUT =
    'sig1=("@method" "@authority" "@path" "content-digest" "content-type" "content-length");created=1618884475;keyid="test-key-ecc-p256"';
  const SIGNATURE =
    'sig1=:X5spyd6CFnAG5QnDyHfqoSNICd+BUP4LYMz2Q0JXlb//4Ijpzp+kve2w4NIyqeAuM7jTDX+sNalzA8ESSaHD3A==:';
  // The signature base, exactly as RFC 9421 prints it.
  const RFC_BASE = [
    '"@method": POST',
    '"@authority": example.com',
    '"@path": /foo',
    `"content-digest": ${DIGEST}`,
    '"content-type": application/json',
    '"content-length": 18',
    `"@signature-params": ${INPUT.slice('sig1='.length)}`,
  ].join('\n');

  const rfcRequest = () =>
    new Request('https://example.com/foo?param=Value&Pet=dog', {
      method: 'POST',
      headers: {
        host: 'example.com',
        date: 'Tue, 20 Apr 2021 02:07:55 GMT',
        'content-type': 'application/json',
        'content-length': '18',
        'content-digest': DIGEST,
        'signature-input': INPUT,
        signature: SIGNATURE,
      },
      body: '{"hello": "world"}',
    });

  const parts = () => {
    const input = parseDictionary(INPUT).get('sig1');
    const sig = parseDictionary(SIGNATURE).get('sig1') as any;
    return { input: input as InnerList, signature: sig.value as Uint8Array };
  };

  it('builds the signature base the RFC prints, byte for byte', () => {
    const { input } = parts();
    const request = rfcRequest();
    const base = signatureBase(
      input.items.map((i) => i.value as string),
      serializeInnerList(input),
      (name) => componentValue(name, request, 'https://example.com/foo'),
    );
    expect(base).toBe(RFC_BASE);
  });

  it("verifies the RFC's signature with the RFC's key", () => {
    const { key } = resolveSigningKey({ keys: [rfcKey] }, 'test-key-ecc-p256');
    const { signature } = parts();
    expect(signature.length).toBe(64);
    expect(verifyEs256(RFC_BASE, signature, key)).toBe(true);
  });

  it('rejects it once any byte of the base changes', () => {
    const { key } = resolveSigningKey({ keys: [rfcKey] }, 'test-key-ecc-p256');
    const { signature } = parts();
    expect(verifyEs256(RFC_BASE.replace('POST', 'PUT'), signature, key)).toBe(false);
    expect(verifyEs256(RFC_BASE.replace('/foo', '/bar'), signature, key)).toBe(false);
    expect(verifyEs256(RFC_BASE.replace('18', '19'), signature, key)).toBe(false);
  });

  it('reads the covered components and the query rule from the request', () => {
    // The RFC request has a query string, so a conforming signature must also cover @query: the
    // spec says "when present", and this one does not, which our reader refuses.
    expect(() => readSignature(rfcRequest())).toThrow(/must cover @query/);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

function setup(
  options: {
    httpSignatures?: boolean | HttpSignatureOptions;
    fetchProfile?: ProfileFetcher;
  } = {},
) {
  const clock = new ManualClock(NOW);
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const state = new MemoryUspState(() => clock.now().getTime());
  const served: Record<string, PlatformProfile> = {};
  const calls: string[] = [];
  const fetchProfile: ProfileFetcher =
    options.fetchProfile ??
    (async (uri) => {
      calls.push(uri);
      const found = served[uri];
      if (!found) throw new Error(`no stub profile for ${uri}`);
      return found;
    });
  const auth = createPopAuthenticator({
    baseUrl: ORIGIN,
    state,
    clock,
    fetchProfile,
    httpSignatures: options.httpSignatures ?? true,
  });
  const app = new Hono().route(
    '/usp',
    createUspRouter({ service, baseUrl: ORIGIN, consent: 'commit', auth, state }),
  );
  return { clock, service, state, auth, app, served, calls };
}
type World = ReturnType<typeof setup>;

async function newPlatform(w: World, profile = AGENT) {
  const p = await signingPlatform(w, profile);
  w.served[profile] = p.profile();
  return p;
}

async function slotAt(w: World, index = 0) {
  const res = await w.app.request('/usp/availability/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: 'haircut',
      start_date: FAR,
      end_date: FAR,
      resource_id: 'maria',
      limit: 4,
    }),
  });
  return ((await res.json()) as any).slots[index] as { id: string };
}

const holdBody = (slot: { id: string }) => ({ slot_id: slot.id, service_id: 'haircut' });
const hold = (p: SigningPlatform, slot: { id: string }, opts: SignedCall = {}) =>
  p.call('POST', '/availability/holds', holdBody(slot), opts);

describe('a signed request', () => {
  it('takes a hold, and the platform is the thumbprint of its published key', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w));
    expect(res.status).toBe(201);
    // RFC 7638, by hand: the required members in lexicographic order.
    const jkt = createHash('sha256')
      .update(JSON.stringify({ crv: p.jwk.crv, kty: p.jwk.kty, x: p.jwk.x, y: p.jwk.y }))
      .digest('base64url');
    expect(p.jkt).toBe(jkt);
    expect(await w.state.ownerOf(res.json.hold.id.replace('hold_', ''))).toBe(jkt);
  });

  it('books, and reads the booking back with no credential: its own identity is enough', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const made = await p.call('POST', '/bookings', {
      ...holdBody(await slotAt(w)),
      buyer: BUYER,
    });
    expect(made.status).toBe(201);
    // No credential is issued: it would have to be bound to a proof key this caller does not use,
    // and an unbound one would be a bearer token.
    expect(made.json.booking_scoped_credential).toBeUndefined();
    const read = await p.call('GET', `/bookings/${made.json.booking.id}`);
    expect(read.status).toBe(200);
    expect(read.json.booking.id).toBe(made.json.booking.id);
  });

  it("is only ever the caller's own: another signing platform cannot reach the booking", async () => {
    const w = setup();
    const a = await newPlatform(w);
    const b = await newPlatform(w, 'https://b.example/profile.json');
    const made = await a.call('POST', '/bookings', { ...holdBody(await slotAt(w)), buyer: BUYER });
    const stolen = await b.call('GET', `/bookings/${made.json.booking.id}`);
    expect(stolen.status).toBe(404);
    expect(stolen.json.type).toBe(type('booking-not-found'));
  });

  it('covers a query string when there is one, and accepts the signature that does', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const made = await p.call('POST', '/bookings', { ...holdBody(await slotAt(w)), buyer: BUYER });
    const id = made.json.booking.id;
    const ok = await p.call('GET', `/bookings/${id}?verbose=1`);
    expect(ok.status).toBe(200);
    const unsignedQuery = await p.call('GET', `/bookings/${id}?verbose=1`, undefined, {
      covered: (usual) => usual.filter((c) => c !== '@query'),
    });
    expect(unsignedQuery.status).toBe(401);
    expect(unsignedQuery.json.detail).toContain('@query');
  });

  it('accepts the RFC 9421 algorithm name, and an extra derived component', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), {
      alg: 'ecdsa-p256-sha256',
      covered: (usual) => [...usual, '@scheme'],
    });
    expect(res.status).toBe(201);
  });
});

describe('what a signed request must carry', () => {
  it('Signature-Input and Signature, both', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    // Unsigned and no DPoP: the business names both mechanisms it takes.
    const none = await hold(p, slot, { unsigned: true });
    expect(none.status).toBe(401);
    expect(none.json.type).toBe(type('authentication-required'));
    expect(none.json.detail).toContain('http_message_signature');
    // Only one of the two headers: a half-made signature, with the code the spec names for it.
    const r = await p.request('POST', '/availability/holds', holdBody(slot));
    for (const drop of ['signature', 'signature-input']) {
      const headers = { ...(r.init.headers as Record<string, string>) };
      delete headers[drop];
      const res = await w.app.request(r.full, { ...r.init, headers });
      expect(res.status, drop).toBe(401);
      const body = (await res.json()) as any;
      expect(body.type).toBe(type('signature-missing'));
      expect(body.mechanism).toBe('http_message_signature');
      expect(problemErrors(body)).toEqual([]);
    }
  });

  for (const component of [
    '@method',
    '@authority',
    '@path',
    'usp-agent',
    'idempotency-key',
    'content-digest',
    'content-type',
  ]) {
    it(`covers ${component}: leaving it out is refused, not trusted for the rest`, async () => {
      const w = setup();
      const p = await newPlatform(w);
      const res = await hold(p, await slotAt(w), {
        covered: (usual) => usual.filter((c) => c !== component),
      });
      expect(res.status).toBe(401);
      expect(res.json.type).toBe(type('signature-invalid'));
      expect(res.json.detail).toContain(component);
      expect(problemErrors(res.json)).toEqual([]);
    });
  }

  it('refuses a component it cannot check, a repeated one, one with parameters, and a request with no keyid', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    const cases: SignedCall[] = [
      { covered: (u) => [...u, '@request-target'] },
      { covered: (u) => [...u, '@method'] },
      { covered: (u) => [...u, '@status'] },
      { covered: (u) => [...u, 'X-Upper-Case'] },
    ];
    for (const c of cases) {
      const res = await hold(p, slot, c);
      expect(res.status, JSON.stringify(res.json)).toBe(401);
      expect(res.json.type).toBe(type('signature-invalid'));
    }
    // Parameters on a component identifier (`"@method";req`) are not supported either.
    const r = await p.request('POST', '/availability/holds', holdBody(slot));
    const headers = r.init.headers as Record<string, string>;
    headers['signature-input'] = headers['signature-input']!.replace('"@method"', '"@method";req');
    const withParam = await w.app.request(r.full, r.init);
    expect(withParam.status).toBe(401);
    const noKeyId = await hold(p, slot, { keyid: '' });
    expect(noKeyId.status).toBe(401);
    expect(noKeyId.json.detail).toContain('keyid');
  });

  it('exactly one signature', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { second: true });
    expect(res.status).toBe(401);
    expect(res.json.detail).toContain('exactly one');
  });

  it('well-formed headers, and a Signature that matches the label', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    const malformed: Array<Record<string, string>> = [
      { 'signature-input': 'sig1=("@method"' },
      { signature: 'sig1=:not base64 at all:' },
      { signature: 'wrong-label=:AAAA:' },
      { signature: 'sig1="a string, not bytes"' },
    ];
    for (const headers of malformed) {
      const res = await hold(p, slot, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.json.type).toBe(type('signature-invalid'));
    }
  });
});

describe('the signature itself', () => {
  it('must verify against the key the profile publishes', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const other = await signingPlatform(w);
    const slot = await slotAt(w);
    // Signed by a key that is not in the profile, under the right keyid.
    const res = await hold(p, slot, { key: other.privateKey });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('signature-invalid'));
  });

  it('is the fixed-width r||s form, not DER', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { der: true });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('signature-invalid'));
  });

  it('covers the whole request: a different authority, path, method or agent is refused', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    // The platform signed another business's authority (a signature captured elsewhere).
    expect((await hold(p, slot, { authority: 'other.example' })).json.type).toBe(
      type('signature-invalid'),
    );
    // Signed for one operation, sent to another.
    expect((await hold(p, slot, { signedPath: '/usp/bookings' })).json.type).toBe(
      type('signature-invalid'),
    );
    // The profile named in USP-Agent is covered, so it cannot be swapped after signing.
    w.served['https://evil.example/profile.json'] = p.profile();
    const swapped = await hold(p, slot, {
      headers: { 'usp-agent': 'profile="https://evil.example/profile.json"' },
    });
    expect(swapped.json.type).toBe(type('signature-invalid'));
    // A signature made to read a booking does not carry a change to it.
    const made = await p.call('POST', '/bookings', {
      ...holdBody(await slotAt(w, 2)),
      buyer: BUYER,
    });
    const read = await p.request('GET', `/bookings/${made.json.booking.id}`);
    const res = await w.app.request(read.full, { ...read.init, method: 'PUT' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).type).toBe(type('signature-invalid'));
  });

  it('falls back to the transition alias signing_keys when keys is absent', async () => {
    const w = setup();
    const p = await signingPlatform(w);
    w.served[AGENT] = { usp: p.profile().usp, signing_keys: [p.jwk] } as PlatformProfile;
    expect((await hold(p, await slotAt(w))).status).toBe(201);
  });

  it('prefers keys over signing_keys when both list the keyid', async () => {
    const w = setup();
    const published = await signingPlatform(w);
    const decoy = await signingPlatform(w); // the same kid, a different key
    w.served[AGENT] = {
      usp: published.profile().usp,
      keys: [published.jwk],
      signing_keys: [decoy.jwk],
    } as PlatformProfile;
    expect((await hold(published, await slotAt(w, 0))).status).toBe(201);
    expect((await hold(decoy, await slotAt(w, 1))).json.type).toBe(type('signature-invalid'));
  });
});

describe('the key in the profile', () => {
  it('is not found: key_not_found', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { keyid: 'rotated-away' });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('key-not-found'));
  });

  it('is of another kind: algorithm_unsupported (400), and the rest of the profile still counts', async () => {
    const w = setup();
    const p = await signingPlatform(w);
    const slot = await slotAt(w);
    const wrong = [
      { ...p.jwk, alg: 'ES384' },
      { ...p.jwk, crv: 'P-384' },
      { ...p.jwk, kty: 'OKP', crv: 'Ed25519', y: undefined },
      { ...p.jwk, use: 'enc' },
    ];
    for (const key of wrong) {
      w.served[AGENT] = { ...p.profile(), keys: [key] } as PlatformProfile;
      const res = await hold(p, slot);
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(res.json.type).toBe(type('algorithm-unsupported'));
    }
  });

  it('is an unsupported algorithm named in the signature: algorithm_unsupported', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { alg: 'rsa-pss-sha512' });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe(type('algorithm-unsupported'));
  });

  it('carries private key material: refused, because a published private key is no key', async () => {
    const w = setup();
    const p = await signingPlatform(w);
    w.served[AGENT] = { ...p.profile(), keys: [{ ...p.jwk, d: 'AAAA' }] } as PlatformProfile;
    const res = await hold(p, await slotAt(w));
    expect(res.status).toBe(401);
    expect(res.json.detail).toContain('private key material');
  });

  it('is not a point on the curve: refused', async () => {
    const w = setup();
    const p = await signingPlatform(w);
    w.served[AGENT] = {
      ...p.profile(),
      keys: [{ ...p.jwk, x: p.jwk.y, y: p.jwk.y }],
    } as PlatformProfile;
    const res = await hold(p, await slotAt(w));
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('signature-invalid'));
  });
});

describe('the body: Content-Digest (RFC 9530)', () => {
  it('is checked against the bytes received', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    // A correct signature over a digest of a body that is not the one sent.
    const res = await hold(p, slot, { sentBody: JSON.stringify({ ...holdBody(slot), x: 1 }) });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe(type('digest-mismatch'));
    const wrong = await hold(p, slot, { digest: 'wrong' });
    expect(wrong.json.type).toBe(type('digest-mismatch'));
  });

  it('cannot be swapped to match a changed body: the digest is covered by the signature', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    const tampered = JSON.stringify({ ...holdBody(slot), service_id: 'other' });
    const res = await hold(p, slot, {
      sentBody: tampered,
      headers: {
        'content-digest': `sha-256=:${createHash('sha256').update(tampered).digest('base64')}:`,
      },
    });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('signature-invalid'));
  });

  it('is required whenever there is a body', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { digest: 'none' });
    expect(res.status).toBe(401);
    expect(res.json.detail).toContain('Content-Digest');
  });

  it('must carry a sha-256 value', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    const sha512 = `sha-512=:${createHash('sha512')
      .update(JSON.stringify(holdBody(slot)))
      .digest('base64')}:`;
    const res = await hold(p, slot, { digest: sha512 });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe(type('digest-mismatch'));
  });
});

describe('replay and freshness', () => {
  it('a replayed request with the same Idempotency-Key does not act twice', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    const r = await p.request('POST', '/bookings', { ...holdBody(slot), buyer: BUYER });
    const first = await w.app.request(r.full, r.init);
    const second = await w.app.request(r.full, r.init);
    expect(first.status).toBe(201);
    expect(((await second.json()) as any).booking.id).toBe(
      ((await first.json()) as any).booking.id,
    );
    // A different request under the same key is refused (the key is bound to its content).
    const other = await p.request(
      'POST',
      '/bookings',
      { ...holdBody(await slotAt(w, 1)), buyer: BUYER },
      {
        idempotencyKey: (r.init.headers as Record<string, string>)['idempotency-key']!,
      },
    );
    const conflict = await w.app.request(other.full, other.init);
    expect(conflict.status).toBe(409);
  });

  it('a signed change without an Idempotency-Key is refused, since nothing else stops a replay', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { idempotencyKey: false });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe(type('invalid-request'));
    expect(res.json.detail).toContain('Idempotency-Key');

    const relaxed = setup({ httpSignatures: { requireIdempotencyKey: false } });
    const q = await newPlatform(relaxed);
    expect((await hold(q, await slotAt(relaxed), { idempotencyKey: false })).status).toBe(201);
  });

  it('honours `expires`, and a `created` window when the business sets one', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const slot = await slotAt(w);
    const now = Math.floor(w.clock.now().getTime() / 1000);
    const expired = await hold(p, slot, { params: `;created=${now - 100};expires=${now - 1}` });
    expect(expired.status).toBe(401);
    expect(expired.json.type).toBe(type('signature-expired'));
    // With `created` and no window configured, an old signature is fine: the spec sets none.
    expect((await hold(p, slot, { params: `;created=${now - 86400}` })).status).toBe(201);

    const strict = setup({ httpSignatures: { maxAgeSeconds: 60 } });
    const q = await newPlatform(strict);
    const slotQ = await slotAt(strict);
    const old = await hold(q, slotQ, { params: `;created=${now - 600}` });
    expect(old.json.type).toBe(type('signature-expired'));
    const future = await hold(q, slotQ, { params: `;created=${now + 600}` });
    expect(future.json.type).toBe(type('signature-expired'));
    const none = await hold(q, slotQ);
    expect(none.json.type).toBe(type('signature-expired'));
    expect((await hold(q, slotQ, { params: `;created=${now - 10}` })).status).toBe(201);
  });
});

describe('no fallback between mechanisms', () => {
  it('a DPoP header makes the request a proof-of-possession one: a valid signature does not rescue it', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), { headers: { dpop: 'not.a.proof' } });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-proof-invalid'));
  });

  it('a credential makes it one too (a cnf-bound credential is never accepted on a signature alone)', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const res = await hold(p, await slotAt(w), {
      headers: { authorization: 'DPoP bsc_madeupcredentialvalue0000' },
    });
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('authentication-required'));
  });

  it('both mechanisms work side by side on one business', async () => {
    const w = setup();
    const signer = await newPlatform(w);
    const popper = await platform(w, 'https://pop.example/profile.json');
    w.served['https://pop.example/profile.json'] = {
      usp: signer.profile().usp,
    } as PlatformProfile;
    expect((await hold(signer, await slotAt(w, 0))).status).toBe(201);
    const second = await popper.call('POST', '/availability/holds', {
      ...holdBody(await slotAt(w, 1)),
    });
    expect(second.status).toBe(201);
  });
});

describe('who it binds', () => {
  it('ties the verifying key to the first profile that presented it', async () => {
    const w = setup();
    const p = await newPlatform(w);
    const second = 'https://second.example/profile.json';
    w.served[second] = p.profile();
    expect((await hold(p, await slotAt(w, 0))).status).toBe(201);
    // The same key, now under another profile (which also lists it): one key, two identities.
    const res = await hold(p, await slotAt(w, 1), { profile: second });
    expect(res.status).toBe(403);
    expect(res.json.type).toBe(type('profile-not-trusted'));
  });

  it('fetches the profile only for a request that is at least well formed', async () => {
    const w = setup();
    await newPlatform(w);
    const junk = await w.app.request('/usp/availability/holds', {
      method: 'POST',
      headers: {
        'usp-agent': `profile="${AGENT}"`,
        'signature-input': 'sig1=("@method"',
        signature: 'sig1=:AAAA:',
      },
      body: '{}',
    });
    expect(junk.status).toBe(401);
    expect(w.calls).toEqual([]);
  });

  it('is off unless the business turns it on, and then says nothing about it in its profile', async () => {
    const off = setup({ httpSignatures: false });
    const p = await newPlatform(off);
    const res = await hold(p, await slotAt(off));
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-proof-missing'));
    const mechanisms = (a: World) =>
      buildUspProfile({
        baseUrl: ORIGIN,
        business: { name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
        bookings: { mechanisms: a.auth.mechanisms },
      });
    expect(mechanisms(off).authorization!.accepted_mechanisms).toEqual([
      'platform_key_pop',
      'booking_scoped_credential',
    ]);
    const on = mechanisms(setup());
    expect(on.authorization!.accepted_mechanisms).toEqual([
      'platform_key_pop',
      'booking_scoped_credential',
      'http_message_signature',
    ]);
    expect(profileErrors(on)).toEqual([]);
  });

  it('needs a way to fetch profiles, since the keys are in them', () => {
    expect(() =>
      createPopAuthenticator({
        baseUrl: ORIGIN,
        state: new MemoryUspState(() => 0),
        clock: new ManualClock(NOW),
        httpSignatures: true,
      }),
    ).toThrow(/fetchProfile/);
  });

  it('is not offered over MCP: that binding takes proofs inside the arguments only', async () => {
    const w = setup();
    await expect(
      w.auth.authenticateMcp!({
        method: 'usp_availability_hold',
        params: {
          _meta: {
            usp: { profile: AGENT, authorization: { mechanism: 'http_message_signature' } },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'authentication_required' });
  });
});
