/**
 * `http_message_signature` verification (spec 9.1.4 and 10.1.6): the platform signs the request
 * with a key it publishes in its own profile (`keys`, else the transition alias `signing_keys`),
 * following HTTP Message Signatures (RFC 9421). The caller needs no onboarding at all: it
 * authenticates by publishing a profile, and the thumbprint of the profile key that verified is its
 * identity.
 *
 * What the spec fixes, and what this file does about it:
 *  - covered components: `@method`, `@authority` and `@path` always; `@query`, `usp-agent` (or
 *    `ucp-agent`), `idempotency-key`, `content-digest` and `content-type` whenever the request has
 *    them. A signature that leaves one out is refused, not trusted for the rest;
 *  - `keyid` names a key in the profile; `created` is optional (replay defence is the signed
 *    `Idempotency-Key`, see below);
 *  - `ES256` (ECDSA P-256 with SHA-256) is the one algorithm we verify, and its value is the
 *    fixed-width `r||s` form of 64 bytes, never DER;
 *  - `Content-Digest` is `sha-256` over the raw body bytes (RFC 9530).
 *
 * The spec is silent on a few points; each choice is listed in docs/SPEC-NOTES.md (section 6),
 * so a future spec change can be checked against them.
 */
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { ProtocolError, type ProtocolCode } from './protocol';
import {
  isInnerList,
  parseDictionary,
  serializeInnerList,
  SfvError,
  type Member,
  type Params,
} from './sfv';

export interface HttpSignatureOptions {
  /**
   * Also refuse a signature whose `created` is older or newer than this many seconds (and one
   * with no `created`). The spec imposes no window on requests, but lets a business add one.
   * Default: none.
   */
  maxAgeSeconds?: number;
  /**
   * A signed request that changes something must carry an `Idempotency-Key`. The spec only says
   * platforms SHOULD send one, yet it is the one thing that stops a captured signed request from
   * being replayed (there is no signature timestamp to expire), so we require it. Default: true.
   */
  requireIdempotencyKey?: boolean;
}

/** The mechanism identifier of the profile's `authorization.accepted_mechanisms`. */
export const HTTP_SIGNATURE = 'http_message_signature';

/** RFC 9421 registry name for ECDSA P-256 with SHA-256; `ES256` is the JOSE name for the same. */
const ALG_NAMES = new Set(['ecdsa-p256-sha256', 'ES256']);

const ALWAYS_COVERED = ['@method', '@authority', '@path'] as const;
const COVERED_WHEN_PRESENT = [
  'usp-agent',
  'ucp-agent',
  'idempotency-key',
  'content-digest',
  'content-type',
] as const;
/** Derived components we can compute. Any other `@…` identifier is refused. */
const DERIVED = new Set(['@method', '@authority', '@path', '@query', '@target-uri', '@scheme']);
const FIELD_NAME = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;

const fail = (code: ProtocolCode, detail: string, extra?: Record<string, unknown>) =>
  new ProtocolError(code, detail, undefined, undefined, extra);

// ---------------------------------------------------------------------------
// Reading the headers (no keys needed yet)
// ---------------------------------------------------------------------------

export interface ParsedSignature {
  label: string;
  /** The covered component identifiers, in the signer's order. */
  components: string[];
  params: Params;
  keyid: string;
  /** The raw signature value. */
  signature: Uint8Array;
  /** The serialized `@signature-params` value: the last line of the signature base. */
  paramsLine: string;
}

/**
 * Parse `Signature-Input` and `Signature` and check the covered components, before any network
 * call is made on the caller's say-so.
 */
export function readSignature(request: Request): ParsedSignature {
  const input = request.headers.get('signature-input');
  const sig = request.headers.get('signature');
  if (input === null || sig === null) {
    throw fail(
      'signature_missing',
      'Sign the request with HTTP Message Signatures: send both Signature-Input and Signature.',
      { mechanism: HTTP_SIGNATURE },
    );
  }
  let inputs: ReturnType<typeof parseDictionary>;
  let sigs: ReturnType<typeof parseDictionary>;
  try {
    inputs = parseDictionary(input);
    sigs = parseDictionary(sig);
  } catch (e) {
    if (e instanceof SfvError) {
      throw fail(
        'signature_invalid',
        'Signature-Input or Signature is not a valid structured field.',
      );
    }
    throw e;
  }
  // One signature per request. RFC 9421 allows several, but which of them a business must act on
  // is not specified, and guessing could let an unchecked one carry a request.
  if (inputs.size !== 1) {
    throw fail('signature_invalid', 'Send exactly one signature (one label in Signature-Input).');
  }
  const [label, member] = [...inputs][0]!;
  const value = sigs.get(label);
  if (
    !isInnerList(member) ||
    value === undefined ||
    isInnerList(value) ||
    !(value.value instanceof Uint8Array)
  ) {
    throw fail(
      'signature_invalid',
      'Signature-Input and Signature do not describe the same signature.',
    );
  }

  const components: string[] = [];
  for (const item of member.items) {
    const name = item.value;
    if (typeof name !== 'string' || item.params.size > 0) {
      throw fail(
        'signature_invalid',
        'Covered components must be plain strings without parameters.',
      );
    }
    if (components.includes(name)) {
      throw fail('signature_invalid', `The component ${name} is covered twice.`);
    }
    if (name.startsWith('@') ? !DERIVED.has(name) : !FIELD_NAME.test(name)) {
      throw fail('signature_invalid', `This business cannot check the covered component ${name}.`);
    }
    components.push(name);
  }

  const keyid = member.params.get('keyid');
  if (typeof keyid !== 'string' || keyid === '') {
    throw fail(
      'signature_invalid',
      'The signature needs a keyid parameter naming a key in your profile.',
    );
  }

  // Covered components (spec 9.1.4): a signature that skips one it must cover protects less than
  // it looks like it does.
  const search = new URL(request.url).search;
  const required = [
    ...ALWAYS_COVERED,
    ...(search === '' ? [] : (['@query'] as const)),
    ...COVERED_WHEN_PRESENT.filter((h) => request.headers.has(h)),
  ];
  const missing = required.find((c) => !components.includes(c));
  if (missing) {
    throw fail('signature_invalid', `The signature must cover ${missing}.`);
  }

  return {
    label,
    components,
    params: member.params,
    keyid,
    signature: value.value,
    paramsLine: serializeInnerList(member),
  };
}

// ---------------------------------------------------------------------------
// The signature base (RFC 9421 section 2.5)
// ---------------------------------------------------------------------------

/** The value of one covered component for this request, or undefined if it has none. */
export function componentValue(
  name: string,
  request: Request,
  publicUrl: string,
): string | undefined {
  const pub = new URL(publicUrl);
  const search = new URL(request.url).search;
  switch (name) {
    case '@method':
      return request.method.toUpperCase();
    case '@authority':
      return pub.host.toLowerCase();
    case '@path':
      return pub.pathname === '' ? '/' : pub.pathname;
    case '@query':
      return `?${search.slice(1)}`;
    case '@scheme':
      return pub.protocol.slice(0, -1);
    case '@target-uri':
      return `${pub.origin}${pub.pathname}${search}`;
    default:
      return request.headers.get(name) ?? undefined;
  }
}

export function signatureBase(
  components: readonly string[],
  paramsLine: string,
  valueOf: (component: string) => string | undefined,
): string {
  const lines = components.map((name) => {
    const value = valueOf(name);
    if (value === undefined) {
      throw fail(
        'signature_invalid',
        `The signature covers ${name}, which this request does not have.`,
      );
    }
    return `"${name}": ${value}`;
  });
  lines.push(`"@signature-params": ${paramsLine}`);
  return lines.join('\n');
}

/** ECDSA P-256 / SHA-256 over `base`, the signature as fixed-width r||s (64 bytes), not DER. */
export function verifyEs256(base: string, signature: Uint8Array, key: KeyObject): boolean {
  if (signature.length !== 64) return false;
  return verify('sha256', Buffer.from(base, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The key-carrying members of a platform profile (an open object, so anything else may be there). */
interface PublishedKeys {
  keys?: unknown;
  signing_keys?: unknown;
  [member: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The key a signature names: `keys` first, then the transition alias `signing_keys` (spec 9.1.4).
 * A key we cannot verify with (another algorithm, or not meant for signing) is "unsupported", not
 * a reason to refuse the whole profile.
 */
export function resolveSigningKey(
  profile: PublishedKeys,
  keyid: string,
): { key: KeyObject; jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string } } {
  let found: Record<string, unknown> | undefined;
  for (const list of [profile.keys, profile.signing_keys]) {
    if (!Array.isArray(list)) continue;
    found = list.find((k): k is Record<string, unknown> => isObject(k) && k.kid === keyid);
    if (found) break;
  }
  if (!found) {
    throw fail('key_not_found', 'No key with this keyid is published in your platform profile.');
  }
  if ('d' in found) {
    // A profile is public: a private member means the key is compromised, and we will not use it.
    throw fail('signature_invalid', 'Your profile publishes private key material for this keyid.');
  }
  if (
    found.kty !== 'EC' ||
    found.crv !== 'P-256' ||
    (found.alg !== undefined && found.alg !== 'ES256') ||
    (found.use !== undefined && found.use !== 'sig') ||
    typeof found.x !== 'string' ||
    typeof found.y !== 'string'
  ) {
    throw fail(
      'algorithm_unsupported',
      'This business verifies ES256 (ECDSA P-256) request signatures.',
    );
  }
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: found.x, y: found.y };
  try {
    return { key: createPublicKey({ key: jwk, format: 'jwk' }), jwk };
  } catch {
    throw fail('signature_invalid', 'The key published for this keyid is not a valid P-256 key.');
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifySignedRequest extends HttpSignatureOptions {
  parsed: ParsedSignature;
  request: Request;
  /** The exact body bytes as text. */
  rawBody: string;
  /** The public URL of the request (no query string): what `@authority` and `@path` are made of. */
  url: string;
  /** The platform profile the request names (it carries the keys). */
  profile: PublishedKeys;
  now: Date;
}

export interface VerifiedSignature {
  /** The RFC 7638 thumbprint of the key that verified: the platform's identity. */
  jkt: string;
  keyid: string;
}

/** Everything after parsing: key, signature, freshness, idempotency key, digest. Throws or returns. */
export async function verifySignedRequest(input: VerifySignedRequest): Promise<VerifiedSignature> {
  const { parsed, request } = input;

  const alg = parsed.params.get('alg');
  if (alg !== undefined && (typeof alg !== 'string' || !ALG_NAMES.has(alg))) {
    throw fail(
      'algorithm_unsupported',
      'This business verifies ES256 (ecdsa-p256-sha256) signatures.',
    );
  }
  const { key, jwk } = resolveSigningKey(input.profile, parsed.keyid);

  const base = signatureBase(parsed.components, parsed.paramsLine, (name) =>
    componentValue(name, request, input.url),
  );
  if (!verifyEs256(base, parsed.signature, key)) {
    throw fail('signature_invalid', 'The signature does not verify against your published key.');
  }

  // From here the caller is authenticated, so these may say what is wrong in detail.
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const created = parsed.params.get('created');
  const expires = parsed.params.get('expires');
  if (typeof expires === 'number' && nowSeconds >= expires) {
    throw fail('signature_expired', 'The signature has expired.');
  }
  if (input.maxAgeSeconds !== undefined) {
    if (typeof created !== 'number' || Math.abs(nowSeconds - created) > input.maxAgeSeconds) {
      throw fail(
        'signature_expired',
        'The signature is missing a created time, or it is too old or new.',
      );
    }
  }
  if (
    input.requireIdempotencyKey !== false &&
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase()) &&
    !request.headers.has('idempotency-key')
  ) {
    throw fail(
      'invalid_request',
      'A signed request that changes something needs an Idempotency-Key, which the signature covers.',
    );
  }
  checkContentDigest(request, input.rawBody);

  return { jkt: await calculateJwkThumbprint(jwk), keyid: parsed.keyid };
}

/** RFC 9530: `Content-Digest: sha-256=:…:` must equal the digest of the body we received. */
function checkContentDigest(request: Request, rawBody: string): void {
  const header = request.headers.get('content-digest');
  if (header === null) {
    if (rawBody.length > 0) {
      throw fail(
        'signature_invalid',
        'A request with a body needs a Content-Digest of it, covered by the signature.',
      );
    }
    return;
  }
  let digest: Member | undefined;
  try {
    digest = parseDictionary(header).get('sha-256');
  } catch {
    throw fail('digest_mismatch', 'Content-Digest is not a valid structured field.');
  }
  if (!digest || isInnerList(digest) || !(digest.value instanceof Uint8Array)) {
    throw fail('digest_mismatch', 'Content-Digest must carry a sha-256 value.');
  }
  const actual = createHash('sha256').update(rawBody, 'utf8').digest();
  const given = Buffer.from(digest.value);
  if (given.length !== actual.length || !timingSafeEqual(given, actual)) {
    throw fail('digest_mismatch', 'Content-Digest does not match the body.');
  }
}
