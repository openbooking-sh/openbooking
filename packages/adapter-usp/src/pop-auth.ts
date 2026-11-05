/**
 * The authenticator for platforms and booking-scoped credentials (spec 10.1.6), for both
 * bindings. Over REST a platform proves itself in one of two ways:
 *
 *   `platform_key_pop` (always on)
 *     USP-Agent: profile="https://agent.example/p.json"   who the platform says it is
 *     DPoP: <proof>                                       a standard RFC 9449 proof, every request
 *     Authorization: DPoP bsc_…                           the credential, once one was issued
 *
 *   `http_message_signature` (opt in: `httpSignatures`)
 *     USP-Agent: profile="https://agent.example/p.json"
 *     Signature-Input, Signature, Content-Digest          RFC 9421, signed with a key the platform
 *                                                         publishes in that profile
 *
 * Over MCP the proof form rides inside the tool arguments (`_meta.usp.profile` and
 * `_meta.usp.authorization.{mechanism, credential, proof}`) and is the `usp-pop+jwt` form. Either
 * way one verifier checks the proof and one `bind` step does the rest, so the bindings cannot
 * drift apart.
 *
 * The platform's identity is the thumbprint of the key that proved it (the proof key, or the
 * profile key that verified the signature): no signup, no shared secret. The first time a key
 * appears we tie it to the profile URI it presented; the same key later presenting another
 * profile is refused (trust on first use, keyed by the principal).
 */
import { randomBytes } from 'node:crypto';
import type { UspAuthenticator, UspIssuedCredential, UspPrincipal } from './auth';
import {
  HTTP_SIGNATURE,
  readSignature,
  verifySignedRequest,
  type HttpSignatureOptions,
} from './http-signature';
import { createPopNonces, type PopNonceOptions } from './nonce';
import { DEFAULT_ALGORITHMS, popChallenge, sha256, verifyPop, type ProofAlgorithm } from './pop';
import type { PlatformProfile, ProfileFetcher } from './profile-fetch';
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
  /**
   * Proof algorithms accepted for `platform_key_pop`. `EdDSA` (Ed25519) is the spec's floor and
   * must be listed; `ES256` (P-256) may be added. Default: `['EdDSA']`.
   */
  proofAlgorithms?: readonly ProofAlgorithm[];
  /**
   * Require a server-issued nonce in every proof. A platform without one is answered with
   * `proof_nonce_required` and a nonce, and retries. Needs a secret shared by every instance.
   */
  nonces?: PopNonceOptions;
  /**
   * Also accept `http_message_signature` (RFC 9421) on REST: platforms sign requests with a key
   * published in their profile. Needs `fetchProfile`, because the keys live in the profile.
   */
  httpSignatures?: boolean | HttpSignatureOptions;
}

const DAY = 24 * 3600_000;

/** `USP-Agent: profile="https://…"` (an RFC 8941 dictionary); only the profile member matters. */
export function parseAgentHeader(
  header: string | null,
  challenge = popChallenge(DEFAULT_ALGORITHMS),
): string {
  if (!header) {
    throw new ProtocolError(
      'authentication_required',
      'Privileged operations need a USP-Agent header naming your platform profile.',
      'Send USP-Agent: profile="https://your-platform.example/profile.json".',
      { 'www-authenticate': challenge },
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

/** What `bind` needs from whichever mechanism just proved who is calling. */
interface Proven {
  /** The platform's identity: a key thumbprint. */
  jkt: string;
  mechanism: string;
  credential?: { scope: readonly string[] };
  /** A profile already fetched while proving (signatures need its keys). */
  platform?: PlatformProfile;
}

export function createPopAuthenticator(options: PopAuthenticatorOptions): UspAuthenticator {
  const origin = new URL(options.baseUrl).origin;
  const expectedUrl = options.htu ?? ((req: Request) => `${origin}${new URL(req.url).pathname}`);
  const grace = options.credentialGraceMs ?? 7 * DAY;
  const audiences = options.audiences ?? [`${options.baseUrl.replace(/\/+$/, '')}/.well-known/usp`];

  const algorithms = [...new Set(options.proofAlgorithms ?? DEFAULT_ALGORITHMS)];
  if (!algorithms.includes('EdDSA')) {
    // The spec makes EdDSA the floor of platform_key_pop: a business that accepts only ES256
    // would turn away every conforming platform.
    throw new Error(
      'proofAlgorithms must include "EdDSA": it is the spec floor for platform_key_pop.',
    );
  }
  const challenge = popChallenge(algorithms);
  const nonces = options.nonces ? createPopNonces(options.nonces) : undefined;
  const signatures = options.httpSignatures
    ? options.httpSignatures === true
      ? {}
      : options.httpSignatures
    : undefined;
  if (signatures && !options.fetchProfile) {
    throw new Error(
      'httpSignatures needs fetchProfile: the signing keys are published in the platform profile.',
    );
  }

  /** After a caller proved itself: fetch the platform's profile and tie its key to it. */
  async function bind(proven: Proven, profileUri: string): Promise<UspPrincipal> {
    // Fetch before binding: a profile that cannot be fetched must not become the one this key
    // is stuck with for good.
    const platform =
      proven.platform ??
      (options.fetchProfile ? await options.fetchProfile(profileUri) : undefined);
    if (!(await options.state.bindProfile(proven.jkt, profileUri))) {
      throw new ProtocolError(
        'profile_not_trusted',
        'This key was first used with a different platform profile.',
        'Use the same profile URI as before, or a new key.',
      );
    }
    return {
      id: proven.jkt,
      mechanism: proven.mechanism,
      ...(platform ? { platform } : {}),
      ...(proven.credential ? { credential: proven.credential } : {}),
    };
  }

  const unauthenticated = (detail: string) =>
    new ProtocolError('authentication_required', detail, undefined, {
      'www-authenticate': challenge,
    });

  /** REST, `http_message_signature`: verify, then bind the verifying key to the profile. */
  async function authenticateSigned(
    request: Request,
    rawBody: string,
    profileUri: string,
  ): Promise<UspPrincipal> {
    // The headers and covered components are checked before we fetch anything on the caller's say-so.
    const parsed = readSignature(request);
    const platform = await options.fetchProfile!(profileUri);
    const verified = await verifySignedRequest({
      ...signatures,
      parsed,
      request,
      rawBody,
      url: expectedUrl(request),
      profile: platform,
      now: options.clock.now(),
    });
    return bind({ jkt: verified.jkt, mechanism: HTTP_SIGNATURE, platform }, profileUri);
  }

  return {
    mechanisms: [
      'platform_key_pop',
      'booking_scoped_credential',
      ...(signatures ? [HTTP_SIGNATURE] : []),
    ],

    async authenticate(request: Request, rawBody: string): Promise<UspPrincipal> {
      const profileUri = parseAgentHeader(request.headers.get('usp-agent'), challenge);

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

      // Which mechanism the caller is using is read from what it sent. A request that carries a
      // credential or a DPoP proof is judged as proof of possession ONLY, even if it also carries
      // a signature: a cnf-bound credential must never be accepted on the strength of another
      // mechanism (spec 10.1.6, downgrade resistance).
      const proof = request.headers.get('dpop') ?? undefined;
      const hasSignature =
        request.headers.has('signature') || request.headers.has('signature-input');
      if (signatures && proof === undefined && credential === undefined) {
        if (hasSignature) return authenticateSigned(request, rawBody, profileUri);
        throw unauthenticated(
          'Authenticate with a DPoP proof (platform_key_pop) or sign the request (http_message_signature).',
        );
      }

      const result = await verifyPop({
        binding: 'rest',
        proof,
        credential,
        now: options.clock.now(),
        algorithms,
        ...(nonces ? { nonces } : {}),
        lookupCredential: (hash) => options.state.findCredential(hash),
        seenJti: (jti, ttlMs) => options.state.seenJti(jti, ttlMs),
        rest: { method: request.method, url: expectedUrl(request) },
      });
      return bind(
        {
          jkt: result.jkt,
          mechanism: 'platform_key_pop',
          ...(result.credential ? { credential: { scope: result.credential.scope } } : {}),
        },
        profileUri,
      );
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
          { 'www-authenticate': challenge },
        );
      }
      const profileUri = checkProfileUri(usp.profile);
      const auth = usp.authorization;
      // The mechanism is caller-asserted. It only decides whether we recognise the request at all:
      // an identifier we do not know is refused, never treated as accepted (OpenRPC
      // McpAuthorization). Both mechanisms we take are verified by the same proof check below.
      // (`http_message_signature` over MCP would be signed at the HTTP layer, which this binding
      // does not look at, so it is not accepted here.)
      if (
        auth !== undefined &&
        (typeof auth !== 'object' ||
          auth === null ||
          (auth.mechanism !== 'platform_key_pop' && auth.mechanism !== 'booking_scoped_credential'))
      ) {
        throw unauthenticated(
          'Over MCP this business accepts platform_key_pop and booking_scoped_credential.',
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
        algorithms,
        ...(nonces ? { nonces } : {}),
        lookupCredential: (hash) => options.state.findCredential(hash),
        seenJti: (jti, ttlMs) => options.state.seenJti(jti, ttlMs),
        mcp: { method, params, audiences },
      });
      return bind(
        {
          jkt: result.jkt,
          mechanism: 'platform_key_pop',
          ...(result.credential ? { credential: { scope: result.credential.scope } } : {}),
        },
        profileUri,
      );
    },

    async issueCredential(principal, resource): Promise<UspIssuedCredential | undefined> {
      // A caller that signed requests (RFC 9421) has no proof key to bind a credential to, and
      // an unbound credential would be a bearer token. It does not need one: it reaches only the
      // holds and bookings it created, by its own identity.
      if (principal.mechanism === HTTP_SIGNATURE) return undefined;
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
