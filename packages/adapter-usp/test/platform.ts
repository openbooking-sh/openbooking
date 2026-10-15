/**
 * A platform for tests: its own Ed25519 key, its profile URL, and signed requests (RFC 9449 DPoP
 * proofs) against any app that has a clock, such as the one built in auth.test.ts.
 */
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Hono } from 'hono';

export const ORIGIN = 'https://studio.example';

/** Anything with the app under test and the clock the authenticator reads. */
export interface World {
  clock: { now(): Date };
  app: Hono;
}

/** What a test needs from a response: the status, headers and the parsed JSON body. */
export interface CallResult {
  status: number;
  headers: { get(name: string): string | null };
  json: any;
}

export const b64 = (s: string) => createHash('sha256').update(s).digest('base64url');

/** A platform: its own key pair, its profile URL, and a way to make signed requests. */
export async function platform(w: World, profile = 'https://agent.example/profile.json') {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  let n = 0;
  // The app and clock requests go to; `use` points the platform at another set of instances.
  let world = w;

  /** A proof for this exact request; every field can be overridden to build a bad one. */
  const proof = async (
    method: string,
    path: string,
    extra: {
      credential?: string;
      iat?: number;
      jti?: string;
      htm?: string;
      htu?: string;
      ath?: string;
      key?: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
      jwk?: typeof jwk;
    } = {},
  ) =>
    new SignJWT({
      htm: extra.htm ?? method,
      htu: extra.htu ?? `${ORIGIN}${path}`,
      iat: extra.iat ?? Math.floor(world.clock.now().getTime() / 1000),
      jti: extra.jti ?? `jti-${jkt.slice(0, 6)}-${++n}`,
      ...(extra.credential !== undefined || extra.ath
        ? { ath: extra.ath ?? b64(extra.credential!) }
        : {}),
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: extra.jwk ?? jwk })
      .sign(extra.key ?? privateKey);

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    opts: {
      credential?: string;
      scheme?: string;
      headers?: Record<string, string>;
      proofOptions?: Parameters<typeof proof>[2];
      noProof?: boolean;
      noAgent?: boolean;
    } = {},
  ): Promise<CallResult> => {
    const full = `/usp${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.noAgent ? {} : { 'usp-agent': `profile="${profile}"` }),
      ...(opts.credential ? { authorization: `${opts.scheme ?? 'DPoP'} ${opts.credential}` } : {}),
      ...opts.headers,
    };
    if (!opts.noProof) {
      headers.dpop = await proof(method, full, {
        ...(opts.credential ? { credential: opts.credential } : {}),
        ...opts.proofOptions,
      });
    }
    const res = await world.app.request(full, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };

  /** Send later requests to another world (for example freshly started instances). */
  const use = (next: World) => {
    world = next;
  };

  return { jkt, jwk, privateKey, proof, call, use };
}

export type Platform = Awaited<ReturnType<typeof platform>>;
