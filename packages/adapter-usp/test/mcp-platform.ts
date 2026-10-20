/**
 * A platform for the MCP binding: its own Ed25519 key, and `tools/call` arguments carrying the
 * MCP form of the proof (`usp-pop+jwt`, with `usp_m`, `aud` and `usp_p` over the arguments).
 * Calls go through the official MCP client, so the whole protocol is exercised, not just a handler.
 */
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { paramsDigest, sha256 } from '../src/pop';

export const PROFILE_URL = 'https://studio.example/.well-known/usp';

export interface McpWorld {
  clock: { now(): Date };
  /** A `fetch` for the MCP endpoint, e.g. `(req) => app.fetch(req)`. */
  fetch: (request: Request) => Promise<Response>;
  url: string;
}

/** A connected MCP client: the real handshake (initialize, initialized) has been done. */
export async function connect(w: McpWorld) {
  const transport = new StreamableHTTPClientTransport(new URL(w.url), {
    fetch: (url, init) => w.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'usp-test-platform', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export interface ProofOverrides {
  aud?: string;
  usp_m?: string;
  usp_p?: string;
  typ?: string;
  iat?: number;
  jti?: string;
  ath?: string;
  key?: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
}

export async function mcpPlatform(
  w: McpWorld,
  client: Client,
  profile = 'https://agent.example/profile.json',
) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  let n = 0;

  /** `_meta.usp` for a privileged call, signed over the arguments it sits in. */
  async function sign(
    tool: string,
    args: Record<string, unknown>,
    opts: {
      credential?: string;
      key?: string | false;
      usp?: Record<string, unknown>;
      proof?: ProofOverrides;
      mechanism?: string;
      noAuthorization?: boolean;
    } = {},
  ) {
    const usp: Record<string, unknown> = {
      profile,
      ...(opts.key === false ? {} : { idempotency_key: opts.key ?? randomUUID() }),
      ...opts.usp,
    };
    const full = { ...args, _meta: { usp } };
    if (!opts.noAuthorization) {
      usp.authorization = {
        mechanism:
          opts.mechanism ??
          (opts.credential !== undefined ? 'booking_scoped_credential' : 'platform_key_pop'),
        ...(opts.credential !== undefined ? { credential: opts.credential } : {}),
        proof: 'pending',
      };
      const p = opts.proof ?? {};
      const claims = {
        usp_m: p.usp_m ?? tool,
        aud: p.aud ?? PROFILE_URL,
        usp_p: p.usp_p ?? paramsDigest(full),
        iat: p.iat ?? Math.floor(w.clock.now().getTime() / 1000),
        jti: p.jti ?? `jti-${jkt.slice(0, 6)}-${++n}`,
        ...(opts.credential !== undefined || p.ath
          ? { ath: p.ath ?? sha256(opts.credential!) }
          : {}),
      };
      (usp.authorization as Record<string, unknown>).proof = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: p.typ ?? 'usp-pop+jwt', jwk })
        .sign(p.key ?? privateKey);
    }
    return full;
  }

  /** Call a tool and return what the client sees: a result, or the JSON-RPC error. */
  async function raw(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ result: any; error: any }> {
    try {
      return { result: await client.callTool({ name: tool, arguments: args }), error: undefined };
    } catch (e) {
      return { result: undefined, error: e };
    }
  }

  return {
    jkt,
    jwk,
    privateKey,
    profile,
    sign,
    raw,
    /** A privileged call, signed. */
    async call(tool: string, args: Record<string, unknown>, opts: Parameters<typeof sign>[2] = {}) {
      return raw(tool, await sign(tool, args, opts));
    },
    /** A public call, no authentication. */
    pub: (tool: string, args: Record<string, unknown> = {}) => raw(tool, args),
  };
}

export type McpPlatform = Awaited<ReturnType<typeof mcpPlatform>>;
