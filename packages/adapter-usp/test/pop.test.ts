/**
 * The spec's own proof-of-possession test vectors (tests/vectors/pop), run against our verifier.
 * They are the MCP form of the proof; the REST form (a standard DPoP proof) shares every check
 * except the claims, and is covered in auth.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jcs, paramsDigest, sha256, verifyPop, type PopCredential } from '../src/pop';
import { ProtocolError } from '../src/protocol';

const dir = new URL('./fixtures/usp-spec/tests/vectors/pop/', import.meta.url);
const vectors = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
const byId = (prefix: string) => vectors.find((v) => v.id.startsWith(prefix));

// The vectors share one business and these argument sets (their usp_p digests prove which).
const AUDIENCE = 'https://business.example.com/.well-known/usp';
const CREATE_PARAMS = byId('001').canonicalization.params;
const CANCEL_PARAMS = byId('002').canonicalization.params;

/** A fresh verifier state per test, with the clock set to the vector's own `iat`. */
function harness(credential?: { value: string; cnf?: { jkt: string } }) {
  const seen = new Set<string>();
  const records = new Map<string, PopCredential>();
  if (credential) {
    records.set(sha256(credential.value), {
      hash: sha256(credential.value),
      // The vectors' credentials carry a 2026-06 expiry that predates their own proofs' `iat`
      // (September 2026): the vectors illustrate the proof, so expiry is not what is under test.
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      jkt: credential.cnf?.jkt,
      scope: [],
    });
  }
  return {
    lookupCredential: async (hash: string) => records.get(hash),
    seenJti: async (jti: string) => {
      if (seen.has(jti)) return true;
      seen.add(jti);
      return false;
    },
  };
}

const run = async (
  v: any,
  paramsFor: (v: any) => unknown,
  state = harness(v.credential),
  overrides: { proof?: string | undefined } = {},
) => {
  const proof = 'proof' in overrides ? overrides.proof : v.proof;
  return verifyPop({
    binding: 'mcp',
    proof,
    ...(v.credential ? { credential: v.credential.value } : {}),
    now: new Date((v.expected_claims?.iat ?? 1789203600) * 1000),
    ...state,
    mcp: {
      method: v.expected_claims?.usp_m ?? 'usp_bookings_cancel',
      params: paramsFor(v),
      audiences: [AUDIENCE],
    },
  });
};

const paramsOf = (v: any) =>
  v.expected_claims?.usp_m === 'usp_bookings_create' ? CREATE_PARAMS : CANCEL_PARAMS;

describe('canonicalization vectors 001-003', () => {
  for (const prefix of ['001', '002', '003']) {
    it(`reproduces the exact JCS bytes and digest of vector ${prefix}`, () => {
      const c = byId(prefix).canonicalization;
      expect(jcs(c.params)).toBe(c.jcs);
      expect(paramsDigest(c.params)).toBe(c.usp_p);
    });
  }

  it('removes only _meta.usp.authorization before hashing', () => {
    const c = byId('001').canonicalization;
    const withAuth = structuredClone(c.params);
    withAuth._meta.usp.authorization = { mechanism: 'platform_key_pop', proof: 'x' };
    expect(paramsDigest(withAuth)).toBe(c.usp_p);
    // Anything else in _meta is covered, so tampering with it changes the digest.
    const tampered = structuredClone(c.params);
    tampered._meta.usp.idempotency_key = 'another-key';
    expect(paramsDigest(tampered)).not.toBe(c.usp_p);
  });
});

describe('accepted proofs', () => {
  it('004: issuance, no credential yet, so no ath; the key is recorded as the identity', async () => {
    const v = byId('004');
    const result = await run(v, paramsOf);
    expect(result.jkt).toBe('UDDReOZl1ipXAfp9wYsm13sDBMK5og--QWdBjzuf6o4');
    expect(result.credential).toBeUndefined();
  });

  it('005: presentation, ath covers the credential and the proof is bound to its key', async () => {
    const v = byId('005');
    const result = await run(v, paramsOf);
    expect(result.jkt).toBe(v.credential.cnf.jkt);
    expect(result.credential?.jkt).toBe(v.credential.cnf.jkt);
  });
});

describe('rejected proofs', () => {
  const rejects = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      return (e as ProtocolError).code;
    }
    throw new Error('expected the proof to be rejected');
  };

  it('006: a credential replayed with a proof from another key', async () => {
    const v = byId('006');
    expect(await rejects(run(v, paramsOf))).toBe(v.reject_code);
  });

  it('007: a bound credential with no proof is never accepted as a bearer token', async () => {
    const v = byId('007');
    expect(await rejects(run(v, paramsOf, harness(v.credential), { proof: undefined }))).toBe(
      v.reject_code,
    );
  });

  it('008: the same proof twice is a replay', async () => {
    const accepted = byId('005');
    const v = byId('008');
    const state = harness(accepted.credential);
    await run(accepted, paramsOf, state); // first presentation
    expect(await rejects(run(v, paramsOf, state))).toBe(v.reject_code);
  });

  it('009: a proof meant for another business', async () => {
    const v = byId('009');
    expect(await rejects(run(v, paramsOf))).toBe(v.reject_code);
  });

  it('010: alg none', async () => {
    const v = byId('010');
    expect(await rejects(run(v, paramsOf))).toBe(v.reject_code);
  });

  it('011: a genuine signature on a key re-labelled with another curve', async () => {
    const v = byId('011');
    expect(await rejects(run(v, paramsOf))).toBe(v.reject_code);
  });

  it('covers every vector in the spec directory', () => {
    expect(vectors.map((v) => v.id.slice(0, 3))).toEqual([
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
      '011',
    ]);
  });
});

describe('the other checks the order requires', () => {
  const base = () => {
    const v = byId('005');
    return { v, state: harness(v.credential) };
  };

  it('refuses a proof whose arguments differ from the call (usp_p)', async () => {
    const { v, state } = base();
    await expect(
      run(v, () => ({ ...CANCEL_PARAMS, booking_id: 'someone-elses-booking' }), state),
    ).rejects.toMatchObject({ code: 'pop_proof_invalid' });
  });

  it('refuses a proof for another method', async () => {
    const { v, state } = base();
    await expect(
      verifyPop({
        binding: 'mcp',
        proof: v.proof,
        credential: v.credential.value,
        now: new Date(v.expected_claims.iat * 1000),
        ...state,
        mcp: { method: 'usp_bookings_get', params: CANCEL_PARAMS, audiences: [AUDIENCE] },
      }),
    ).rejects.toMatchObject({ code: 'pop_proof_invalid' });
  });

  it('refuses a stale proof and one from the future', async () => {
    const { v } = base();
    for (const offset of [-61, 61]) {
      await expect(
        verifyPop({
          binding: 'mcp',
          proof: v.proof,
          credential: v.credential.value,
          now: new Date((v.expected_claims.iat + offset) * 1000),
          ...harness(v.credential),
          mcp: { method: 'usp_bookings_cancel', params: CANCEL_PARAMS, audiences: [AUDIENCE] },
        }),
      ).rejects.toMatchObject({ code: 'pop_proof_invalid' });
    }
  });

  it('refuses an unknown credential, and an MCP proof presented as a REST one', async () => {
    const { v } = base();
    await expect(
      verifyPop({
        binding: 'mcp',
        proof: v.proof,
        credential: 'bsc_unknownunknownunknown',
        now: new Date(v.expected_claims.iat * 1000),
        ...harness(),
        mcp: { method: 'usp_bookings_cancel', params: CANCEL_PARAMS, audiences: [AUDIENCE] },
      }),
    ).rejects.toMatchObject({ code: 'authentication_required' });

    // The `typ` differs on purpose so neither proof can be replayed as the other.
    await expect(
      verifyPop({
        binding: 'rest',
        proof: v.proof,
        now: new Date(v.expected_claims.iat * 1000),
        ...harness(),
        rest: { method: 'POST', url: 'https://business.example.com/usp/bookings' },
      }),
    ).rejects.toMatchObject({ code: 'pop_proof_invalid' });
  });
});
