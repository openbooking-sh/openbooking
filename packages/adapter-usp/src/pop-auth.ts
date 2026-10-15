/**
 * The REST authenticator for `platform_key_pop` and booking-scoped credentials (spec 10.1.6):
 *
 *   USP-Agent: profile="https://agent.example/p.json"   who the platform says it is
 *   DPoP: <proof>                                       a standard RFC 9449 proof, every request
 *   Authorization: DPoP bsc_…                           the credential, once one was issued
 *
 * The platform's identity is the thumbprint of the key that signed the proof: no signup, no shared
 * secret. The first time a key appears we tie it to the profile URI it presented; the same key
 * later presenting another profile is refused (trust on first use, keyed by the principal).
 */
import { randomBytes } from 'node:crypto';
import type { UspAuthenticator, UspIssuedCredential, UspPrincipal } from './auth';
import { sha256, verifyPop } from './pop';
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
   * Check the platform's profile (it must be fetchable over HTTPS, spec 8.2.3). Throw to refuse.
   * Not set by default: the hardened fetcher is a separate piece, so until it is plugged in the
   * profile URI is recorded but not retrieved.
   */
  checkProfile?: (profileUri: string) => Promise<void>;
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
  const m = /(?:^|[,\s])profile="([^"]+)"/.exec(header);
  let url: URL | undefined;
  try {
    url = m?.[1] ? new URL(m[1]) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ProtocolError(
      'invalid_profile_url',
      'The USP-Agent profile must be an https URL without credentials or a fragment.',
    );
  }
  return url.href;
}

export function createPopAuthenticator(options: PopAuthenticatorOptions): UspAuthenticator {
  const origin = new URL(options.baseUrl).origin;
  const expectedUrl = options.htu ?? ((req: Request) => `${origin}${new URL(req.url).pathname}`);
  const grace = options.credentialGraceMs ?? 7 * DAY;

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
          throw new ProtocolError(
            'authentication_required',
            'Present a booking credential with Authorization: DPoP <credential>, plus a DPoP proof.',
            undefined,
            challenge,
          );
        }
        credential = m[1];
      }

      const now = options.clock.now();
      const result = await verifyPop({
        binding: 'rest',
        proof: request.headers.get('dpop') ?? undefined,
        credential,
        now,
        lookupCredential: (hash) => options.state.findCredential(hash),
        seenJti: (jti, ttlMs) => options.state.seenJti(jti, ttlMs),
        rest: { method: request.method, url: expectedUrl(request) },
      });

      if (!(await options.state.bindProfile(result.jkt, profileUri))) {
        throw new ProtocolError(
          'profile_not_trusted',
          'This key was first used with a different platform profile.',
          'Use the same profile URI as before, or a new key.',
        );
      }
      if (options.checkProfile) {
        try {
          await options.checkProfile(profileUri);
        } catch {
          throw new ProtocolError(
            'profile_unreachable',
            'The platform profile could not be fetched.',
          );
        }
      }
      return {
        id: result.jkt,
        ...(result.credential ? { credential: { scope: result.credential.scope } } : {}),
      };
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
