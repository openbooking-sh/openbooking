/**
 * `platform_key_pop` verification (spec section 10.1.6): the caller proves it holds a key it made
 * itself and never sends. The key's RFC 7638 thumbprint (`jkt`) is the platform's identity, with
 * no signup and no pre-shared secret.
 *
 * One verifier serves both bindings, because the checks are the same and only the claims differ:
 *  - REST: a standard RFC 9449 DPoP proof (`typ: dpop+jwt`, claims `htm`, `htu`, `ath`).
 *  - MCP: `typ: usp-pop+jwt` with `usp_m`, `aud`, `usp_p` (a digest of the canonicalized params).
 *
 * The spec fixes the order of the checks (10.1.6 "Verification order"): the error returned for a
 * bad request depends on which check fails first, and reordering them would reveal which part of
 * a request was wrong. The numbered comments below are that list.
 */
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader, importJWK } from 'jose';
import type { JWK } from 'jose';
import { ProtocolError } from './protocol';

/** The only algorithm and curve we accept (the spec's floor for `platform_key_pop`). */
const ALG = 'EdDSA';
const CRV = 'Ed25519';
const TYP = { rest: 'dpop+jwt', mcp: 'usp-pop+jwt' } as const;

/** Proofs older or newer than this are refused; `jti`s are remembered for twice as long. */
export const POP_SKEW_SECONDS = 60;

export interface PopCredential {
  /** `sha256` of the credential value, base64url. The value itself is never stored. */
  hash: string;
  expiresAt: Date;
  /** JWK thumbprint the credential is bound to. A credential with one is never a bearer token. */
  jkt?: string | undefined;
  scope: readonly string[];
}

export interface PopInput {
  binding: 'rest' | 'mcp';
  /** The proof (the `DPoP` header over REST, `_meta.usp.authorization.proof` over MCP). */
  proof: string | undefined;
  /** The presented `booking_scoped_credential` value, if any. */
  credential?: string | undefined;
  now: Date;
  lookupCredential(hash: string): Promise<PopCredential | undefined>;
  /** True if this `jti` was already seen; records it otherwise. */
  seenJti(jti: string, ttlMs: number): Promise<boolean>;
  /** REST: the request being made, for `htm` and `htu`. */
  rest?: { method: string; url: string };
  /** MCP: the method, its params, and the profile URIs this business publishes. */
  mcp?: { method: string; params: unknown; audiences: readonly string[] };
}

export interface PopResult {
  /** The platform identity: the thumbprint of the key that signed the proof. */
  jkt: string;
  credential?: PopCredential;
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

const reject = (
  code:
    | 'pop_proof_missing'
    | 'pop_proof_invalid'
    | 'pop_key_mismatch'
    | 'pop_proof_replayed'
    | 'authentication_required',
  detail: string,
) => new ProtocolError(code, detail, undefined, { 'www-authenticate': `DPoP algs="${ALG}"` });

/** RFC 8785 JSON Canonicalization: keys sorted by UTF-16 code unit, minimal string escaping. */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS cannot represent NaN or Infinity.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
      .join(',')}}`;
  }
  throw new Error('JCS cannot represent this value.');
}

/** `usp_p`: the digest of the params with only `_meta.usp.authorization` removed (spec 9.2.2). */
export function paramsDigest(params: unknown): string {
  const copy = structuredClone(params) as { _meta?: { usp?: Record<string, unknown> } } | null;
  const usp = copy && typeof copy === 'object' ? copy._meta?.usp : undefined;
  if (usp && typeof usp === 'object') {
    delete usp.authorization; // an emptied `usp` stays as {}, it is not removed
  }
  return sha256(jcs(copy));
}

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

export async function verifyPop(input: PopInput): Promise<PopResult> {
  // 1. The credential is known and unexpired.
  let credential: PopCredential | undefined;
  if (input.credential !== undefined) {
    credential = await input.lookupCredential(sha256(input.credential));
    if (!credential || credential.expiresAt <= input.now) {
      throw reject('authentication_required', 'The credential is unknown or has expired.');
    }
  }

  // 2. A credential with `cnf` makes a proof mandatory, whatever mechanism the caller declares.
  if (!input.proof) {
    throw reject(
      'pop_proof_missing',
      credential?.jkt
        ? 'This credential is bound to a key; present a proof made with that key.'
        : 'A proof of possession is required.',
    );
  }

  // 3. (The credential's scope against the addressed resource is checked by the caller, which
  //    knows the resource.)

  // 4. The proof parses and its `typ` matches the binding in use.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.proof);
  } catch {
    throw reject('pop_proof_invalid', 'The proof is not a well-formed JWS.');
  }
  if (header.typ !== TYP[input.binding]) {
    throw reject('pop_proof_invalid', `The proof must have typ "${TYP[input.binding]}".`);
  }

  // 5. The algorithm is accepted (never `none`) and the key's curve is the one it requires.
  if (header.alg !== ALG) {
    throw reject('pop_proof_invalid', `The proof must be signed with ${ALG}.`);
  }
  const jwk = header.jwk as JWK | undefined;
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'OKP' || jwk.crv !== CRV) {
    throw reject('pop_proof_invalid', `The proof key must be an OKP ${CRV} public key.`);
  }
  if (PRIVATE_MEMBERS.some((m) => m in jwk)) {
    throw reject('pop_proof_invalid', 'The proof header must not contain private key material.');
  }
  if (typeof jwk.x !== 'string' || Buffer.from(jwk.x, 'base64url').length !== 32) {
    throw reject('pop_proof_invalid', 'The proof key is malformed.');
  }

  // 6. The thumbprint equals the one the credential is bound to (any `kid` is ignored).
  const jkt = await calculateJwkThumbprint({ kty: 'OKP', crv: CRV, x: jwk.x });
  if (credential?.jkt && credential.jkt !== jkt) {
    throw reject(
      'pop_key_mismatch',
      'The proof was made with a different key than the credential.',
    );
  }

  // 7. The signature verifies against the header key.
  let claims: Record<string, unknown>;
  try {
    const key = await importJWK({ kty: 'OKP', crv: CRV, x: jwk.x }, ALG);
    const { payload } = await compactVerify(input.proof, key, { algorithms: [ALG] });
    claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  } catch {
    throw reject('pop_proof_invalid', 'The proof signature does not verify.');
  }

  // 8. `aud` is a profile this business publishes (MCP), or `htm` and `htu` match (REST).
  // 9. `usp_m` is the invoked method and `usp_p` the digest of the arguments (MCP).
  if (input.binding === 'mcp') {
    const mcp = input.mcp!;
    if (typeof claims.aud !== 'string' || !mcp.audiences.includes(claims.aud)) {
      throw reject('pop_proof_invalid', 'The proof is not for this business.');
    }
    if (claims.usp_m !== mcp.method) {
      throw reject('pop_proof_invalid', 'The proof is for a different method.');
    }
    if (claims.usp_p !== paramsDigest(mcp.params)) {
      throw reject('pop_proof_invalid', 'The proof does not cover these arguments.');
    }
  } else {
    const rest = input.rest!;
    if (claims.htm !== rest.method.toUpperCase() || claims.htu !== rest.url) {
      throw reject('pop_proof_invalid', 'The proof is for a different request.');
    }
  }

  // 10. `ath` matches the presented credential.
  if (credential && claims.ath !== sha256(input.credential!)) {
    throw reject('pop_proof_invalid', 'The proof does not cover this credential.');
  }

  // 11. `iat` is within the skew.
  const iat = claims.iat;
  if (typeof iat !== 'number' || Math.abs(input.now.getTime() / 1000 - iat) > POP_SKEW_SECONDS) {
    throw reject('pop_proof_invalid', 'The proof is too old or from the future.');
  }

  // 12. `jti` has not been seen; record it. Reads are covered too: a captured proof must not
  //     replay against the responses that carry buyer data.
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) {
    throw reject('pop_proof_invalid', 'The proof has no jti.');
  }
  if (await input.seenJti(`${jkt}:${claims.jti}`, POP_SKEW_SECONDS * 2 * 1000)) {
    throw reject('pop_proof_replayed', 'This proof was already used.');
  }

  return { jkt, ...(credential ? { credential } : {}) };
}
