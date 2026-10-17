/**
 * The authenticator for `platform_key_pop` and booking-scoped credentials (spec 10.1.6), for both
 * bindings. Over REST:
 *
 *   USP-Agent: profile="https://agent.example/p.json"   who the platform says it is
 *   DPoP: <proof>                                       a standard RFC 9449 proof, every request
 *   Authorization: DPoP bsc_…                           the credential, once one was issued
 *
 * Over MCP the same things ride inside the tool arguments (`_meta.usp.profile` and
 * `_meta.usp.authorization.{mechanism, credential, proof}`) and the proof is the `usp-pop+jwt`
 * form. Either way one verifier checks the proof and one `bind` step does the rest, so the two
 * bindings cannot drift apart.
 *
 * The platform's identity is the thumbprint of the key that signed the proof: no signup, no shared
 * secret. The first time a key appears we tie it to the profile URI it presented; the same key
 * later presenting another profile is refused (trust on first use, keyed by the principal).
 */
import { randomBytes } from 'node:crypto';
import type { UspAuthenticator, UspIssuedCredential, UspPrincipal } from './auth';
import { sha256, verifyPop, type PopResult } from './pop';
import type { ProfileFetcher } from './profile-fetch';
import { ProtocolError } from './protocol';
import type { UspStateStore } from './state';

export interface PopAuthenticatorOptions {
  /** Public origin of this business, e.g. `https://bistro.example.com`: what `htu` is checked on. */
  baseUrl: string;
  state: UspStateStore;
  /** The engine's clock (`service.clock`), so tests can move time. */
  clock: { now(): Date };
  /** Override how the expected `htu` is built, e.g. behind a proxy that rewrites the path. */
  htu?: (request: Request) => string;
  /**
   * Profile URIs an MCP proof's `aud` may name. Default: `${baseUrl}/.well-known/usp`, the profile
   * this business publishes.
   */
  audiences?: readonly string[];
  /**
   * Fetch the platform's profile (it must be reachable over HTTPS, spec 8.2.3); it throws a
   * `ProtocolError` when it cannot. Use `createProfileFetcher()`. Without it the profile URI is
   * recorded but not retrieved, so no capability negotiation happens.
   */
  fetchProfile?: ProfileFetcher;
  /** How long a credential stays valid after the booking ends. Default 7 days. */
  credentialGraceMs?: number;
}

const DAY = 24 * 3600_000;
const challenge = { 'www-authenticate': 'DPoP algs="EdDSA"' };

/** `USP-Agent: profile="https://…"` (an RFC 8941 dictionary); only the profile member matters. */
export function parseAgentHeader(header: string | null): string {
  if (!header) {
    throw new ProtocolError(
      'authentication_required',
      'Privileged operations need a USP-Agent header naming your platform profile.',
      'Send USP-Agent: profile="https://your-platform.example/profile.json".',
      challenge,
    );
  }
  return checkProfileUri(/(?:^|[,\s])profile="([^"]+)"/.exec(header)?.[1]);
}

/** The platform profile URI (`USP-Agent` over REST, `_meta.usp.profile` over MCP): https, plain. */
export function checkProfileUri(uri: unknown): string {
  let url: URL | undefined;
  try {
    url = typeof uri === 'string' && uri ? new URL(uri) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ProtocolError(
      'invalid_profile_url',
      'The platform profile must be an https URL without credentials or a fragment.',
    );
  }
  return url.href;
}

export function createPopAuthenticator(options: PopAuthenticatorOptions): UspAuthenticator {
  const origin = new URL(options.baseUrl).origin;
  const expectedUrl = options.htu ?? ((req: Request) => `${origin}${new URL(req.url).pathname}`);
  const grace = options.credentialGraceMs ?? 7 * DAY;
  const audiences = options.audiences ?? [`${options.baseUrl.replace(/\/+$/, '')}/.well-known/usp`];

  /** After a proof verified: fetch the platform's profile and tie its key to it (both bindings). */
  async function bind(result: PopResult, profileUri: string): Promise<UspPrincipal> {
    // Fetch before binding: a profile that cannot be fetched must not become the one this key
    // is stuck with for good.
    const platform = options.fetchProfile ? await options.fetchProfile(profileUri) : undefined;
    if (!(await options.state.bindProfile(result.jkt, profileUri))) {
      throw new ProtocolError(
        'profile_not_trusted',
        'This key was first used with a different platform profile.',
        'Use the same profile URI as before, or a new key.',
      );
    }
    return {
      id: result.jkt,
      ...(platform ? { platform } : {}),
      ...(result.credential ? { credential: { scope: result.credential.scope } } : {}),
    };
  }

  const unauthenticated = (detail: string) =>
    new ProtocolError('authentication_required', detail, undefined, challenge);

  return {
    mechanisms: ['platform_key_pop', 'booking_scoped_credential'],

    async authenticate(request: Request): Promise<UspPrincipal> {
      const profileUri = parseAgentHeader(request.headers.get('usp-agent'));

      // A sender-constrained credential travels under the DPoP scheme, never as a bearer token.
      let credential: string | undefined;
      const authorization = request.headers.get('authorization');
      if (authorization) {
        const m = /^DPoP\s+(\S+)$/i.exec(authorization);
        if (!m) {
          throw unauthenticated(
            'Present a booking credential with Authorization: DPoP <credential>, plus a DPoP proof.',
          );
        }
        credential = m[1];
      }

      const result = await verifyPop({
        binding: 'rest',
        proof: request.headers.get('dpop') ?? undefined,
        credential,
        now: options.clock.now(),
        lookupCredential: (hash) => options.state.findCredential(hash),
        seenJti: (jti, ttlMs) => options.state.seenJti(jti, ttlMs),
        rest: { method: request.method, url: expectedUrl(request) },
      });
      return bind(result, profileUri);
    },

    async authenticateMcp({ method, params }): Promise<UspPrincipal> {
      const usp = ((params as { _meta?: { usp?: unknown } } | null)?._meta?.usp ?? {}) as {
        profile?: unknown;
        authorization?: { mechanism?: unknown; credential?: unknown; proof?: unknown };
      };
      if (usp.profile === undefined) {
        throw new ProtocolError(
          'authentication_required',
          'Privileged operations need _meta.usp.profile naming your platform profile.',
          'Send _meta.usp.profile with the https URL of your platform profile.',
          challenge,
        );
      }
      const profileUri = checkProfileUri(usp.profile);
      const auth = usp.authorization;
      // The mechanism is caller-asserted. It only decides whether we recognise the request at all:
      // an identifier we do not know is refused, never treated as accepted (OpenRPC
      // McpAuthorization). Both mechanisms we take are verified by the same proof check below.
      if (
        auth !== undefined &&
        (typeof auth !== 'object' ||
          auth === null ||
          (auth.mechanism !== 'platform_key_pop' && auth.mechanism !== 'booking_scoped_credential'))
      ) {
        throw unauthenticated(
          'This business accepts platform_key_pop and booking_scoped_credential.',
        );
      }
      if (auth && auth.credential !== undefined && typeof auth.credential !== 'string') {
        throw unauthenticated('authorization.credential must be a string.');
      }
      if (auth?.mechanism === 'booking_scoped_credential' && auth.credential === undefined) {
        throw unauthenticated(
          'The booking_scoped_credential mechanism needs authorization.credential.',
        );
      }
      const result = await verifyPop({
        binding: 'mcp',
        proof: typeof auth?.proof === 'string' ? auth.proof : undefined,
        credential: auth?.credential as string | undefined,
        now: options.clock.now(),
        lookupCredential: (hash) => options.state.findCredential(hash),
        seenJti: (jti, ttlMs) => options.state.seenJti(jti, ttlMs),
        mcp: { method, params, audiences },
      });
      return bind(result, profileUri);
    },

    async issueCredential(principal, resource): Promise<UspIssuedCredential> {
      // 192 bits of randomness, well over the 128 the spec asks for.
      const value = `bsc_${randomBytes(24).toString('base64url')}`;
      const expiresAt = new Date(resource.endsAt.getTime() + grace);
      const scope = [`booking:${resource.id}`];
      await options.state.saveCredential({
        hash: sha256(value),
        expiresAt,
        jkt: principal.id,
        scope,
      });
      // `cnf` is echoed so the platform can see the credential really is bound to its key.
      return { value, expires_at: expiresAt.toISOString(), cnf: { jkt: principal.id }, scope };
    },
  };
}
