/**
 * A platform that signs its requests with HTTP Message Signatures (RFC 9421): its own P-256 key,
 * published in its profile under `keys`, and a request builder whose signature base is written out
 * by hand here (plain string composition), so the verifier under test is not checked against a
 * second copy of its own code.
 *
 * Every field of a request can be overridden to build a bad one.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { ORIGIN, type CallResult, type World } from './platform';
import { platformProfile } from './platform-profile';
import type { PlatformProfile } from '../src';

export const KID = 'platform-2026';

export interface SignedCall {
  /** What the platform puts in the `Idempotency-Key` header. `false` leaves it out. */
  idempotencyKey?: string | false;
  /** The `keyid` signature parameter. */
  keyid?: string;
  /** Sign with a different key than the one in the profile. */
  key?: KeyObject;
  /** The covered components, or a function from the usual list to the list to cover. */
  covered?: string[] | ((usual: string[]) => string[]);
  /** Extra signature parameters, written as `;created=123;expires=456`. */
  params?: string;
  /** The `alg` signature parameter. */
  alg?: string;
  /** What the signer believes the authority and path are, if not the real ones. */
  authority?: string;
  signedPath?: string;
  /** `none` sends no Content-Digest; `wrong` sends one for other bytes; or give the exact header. */
  digest?: 'none' | 'wrong' | string;
  /** Send DER instead of the fixed-width r||s form. */
  der?: boolean;
  label?: string;
  /** Add a second signature (a second label) to the headers. */
  second?: boolean;
  /** Send no signature headers at all. */
  unsigned?: boolean;
  /** Extra or replacement request headers, applied after signing. */
  headers?: Record<string, string>;
  /** The USP-Agent profile. */
  profile?: string;
  /** Send this body instead of the signed one (the Content-Digest stays that of the original). */
  sentBody?: string;
}

export async function signingPlatform(
  w: World,
  profileUri = 'https://agent.example/profile.json',
  publicBase = ORIGIN,
) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' }) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  const jwk = { kty, crv, x, y, kid: KID, alg: 'ES256', use: 'sig' };
  const jkt = await calculateJwkThumbprint({ kty, crv, x, y });
  const authority = new URL(publicBase).host;

  /** The platform profile as published: the usual capabilities plus the signing key. */
  const profile = (extra: Record<string, unknown> = {}): PlatformProfile =>
    ({ ...platformProfile(), keys: [jwk], ...extra }) as PlatformProfile;

  const sha256 = (s: string) => `sha-256=:${createHash('sha256').update(s).digest('base64')}:`;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    opts: SignedCall = {},
  ): Promise<{ method: string; full: string; init: RequestInit }> {
    const full = `/usp${path}`;
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      'usp-agent': `profile="${opts.profile ?? profileUri}"`,
    };
    if (text !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey !== false && method !== 'GET') {
      headers['idempotency-key'] =
        opts.idempotencyKey ?? `key-${Math.random().toString(36).slice(2, 12)}`;
    }
    if (text !== undefined && opts.digest !== 'none') {
      headers['content-digest'] =
        opts.digest === undefined
          ? sha256(text)
          : opts.digest === 'wrong'
            ? sha256(`${text} `)
            : opts.digest;
    }

    const query = full.includes('?') ? full.slice(full.indexOf('?') + 1) : '';
    const pathOnly = full.split('?')[0]!;
    const usual = [
      '@method',
      '@authority',
      '@path',
      ...(query ? ['@query'] : []),
      ...['usp-agent', 'idempotency-key', 'content-digest', 'content-type'].filter(
        (h) => h in headers,
      ),
    ];
    const covered =
      typeof opts.covered === 'function' ? opts.covered(usual) : (opts.covered ?? usual);

    const values: Record<string, string> = {
      '@method': method,
      '@authority': opts.authority ?? authority,
      '@path': opts.signedPath ?? `${new URL(publicBase).pathname.replace(/\/$/, '')}${pathOnly}`,
      '@query': `?${query}`,
      '@scheme': new URL(publicBase).protocol.slice(0, -1),
      ...headers,
    };
    const paramsLine =
      `(${covered.map((c) => `"${c}"`).join(' ')})` +
      `;keyid="${opts.keyid ?? KID}"` +
      (opts.alg ? `;alg="${opts.alg}"` : '') +
      (opts.params ?? '');
    const base = [
      ...covered.map((c) => `"${c}": ${values[c]}`),
      `"@signature-params": ${paramsLine}`,
    ].join('\n');
    const signature = sign('sha256', Buffer.from(base), {
      key: opts.key ?? pair.privateKey,
      ...(opts.der ? {} : { dsaEncoding: 'ieee-p1363' as const }),
    });

    const label = opts.label ?? 'sig1';
    if (!opts.unsigned) {
      headers['signature-input'] = `${label}=${paramsLine}`;
      headers.signature = `${label}=:${signature.toString('base64')}:`;
      if (opts.second) {
        headers['signature-input'] += `, other=${paramsLine}`;
        headers.signature += `, other=:${signature.toString('base64')}:`;
      }
    }
    Object.assign(headers, opts.headers);
    return {
      method,
      full,
      init: {
        method,
        headers,
        ...(text === undefined ? {} : { body: opts.sentBody ?? text }),
      },
    };
  }

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    opts: SignedCall = {},
  ): Promise<CallResult> => {
    const r = await request(method, path, body, opts);
    const res = await w.app.request(r.full, r.init);
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };

  return { jwk, jkt, kid: KID, privateKey: pair.privateKey, profile, request, call };
}

export type SigningPlatform = Awaited<ReturnType<typeof signingPlatform>>;
