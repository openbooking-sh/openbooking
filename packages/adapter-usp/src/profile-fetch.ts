/**
 * Fetching a platform's profile (spec 8.2.3 and 8.3). The platform names the URL, so this is the
 * one place where a caller makes our server send a request, and it is built so that a platform
 * cannot use it to reach anything but the public internet:
 *
 *  - https only, on port 443, no credentials in the URL, and a host name (never an IP literal);
 *  - DNS is resolved once, and the request is refused if ANY answer is a private or special-use
 *    address (loopback, link-local such as the cloud metadata address, private ranges, ...);
 *  - the connection goes to that exact validated address, with the host name only for TLS (SNI and
 *    certificate checks), so a second DNS answer cannot redirect it afterwards (DNS rebinding);
 *  - no redirects, a time limit, a size limit, and a JSON content type;
 *  - answers are cached by URI (kept for the profile's `Cache-Control`, at least 60 seconds), a
 *    failure is remembered briefly so a bad URL cannot be used to hammer a host, and concurrent
 *    requests for one URI share a single fetch.
 */
import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import * as z from 'zod';
import { ProtocolError } from './protocol';

// ---------------------------------------------------------------------------
// What a platform profile looks like to us (profile.json#PlatformProfile, the parts we read)
// ---------------------------------------------------------------------------

const VERSION = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const PlatformProfileSchema = z.looseObject({
  usp: z.looseObject({
    version: VERSION,
    capabilities: z.record(z.string(), z.array(z.looseObject({ version: VERSION }))),
  }),
});
export type PlatformProfile = z.infer<typeof PlatformProfileSchema>;

/** Fetches (and caches) the profile at a URI, or throws a `ProtocolError`. */
export type ProfileFetcher = (uri: string) => Promise<PlatformProfile>;

// ---------------------------------------------------------------------------
// Special-use addresses: where a profile URL may never lead
// ---------------------------------------------------------------------------

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: can embed any IPv4 address, including private ones
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo and others)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** True for any address a profile fetch must not reach. Unparseable input counts as blocked. */
export function isSpecialUseAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1 or ::ffff:0a00:0001) is that IPv4 address.
    const mapped = mappedIpv4(address);
    if (mapped) return blocked.check(mapped, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

function mappedIpv4(address: string): string | undefined {
  const a = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (!hex) return undefined;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

export interface ProfileFetcherOptions {
  /** Whole-request time limit. Default 5 seconds. */
  timeoutMs?: number;
  /** Largest profile accepted. Default 256 KiB. */
  maxBytes?: number;
  /** Cache lifetime when the response gives none. Default 300 seconds. Never below 60. */
  defaultTtlSeconds?: number;
  /** How long a failure is remembered. Default 30 seconds. */
  failureTtlSeconds?: number;
  /** How many profiles to keep. Default 1000. */
  maxEntries?: number;
  now?: () => number;
  /** DNS resolution (inject in tests). Must return every address for the host. */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /**
   * The HTTPS client (inject in tests). Called with the pinned address as `host` and the real
   * host name in `servername` and the `Host` header.
   */
  httpsRequest?: (
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => ClientRequest;
}

type Entry = { until: number } & ({ profile: PlatformProfile } | { error: ProtocolError });

const unreachable = (detail: string) => new ProtocolError('profile_unreachable', detail);

export function createProfileFetcher(options: ProfileFetcherOptions = {}): ProfileFetcher {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const defaultTtl = Math.max(60, options.defaultTtlSeconds ?? 300);
  const failureTtl = options.failureTtlSeconds ?? 30;
  const maxEntries = options.maxEntries ?? 1000;
  const now = options.now ?? Date.now;
  const resolve =
    options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  const send = options.httpsRequest ?? httpsRequest;

  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<PlatformProfile>>();

  /** Validate the URI and return its parts, or throw. */
  function target(uri: string): { hostname: string; path: string } {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new ProtocolError('invalid_profile_url', 'The profile is not a valid URL.');
    }
    const bad =
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port !== '' && url.port !== '443') ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
      !url.hostname.includes('.');
    if (bad) {
      throw new ProtocolError(
        'invalid_profile_url',
        'The profile must be an https URL on port 443 with a host name, and no credentials or fragment.',
      );
    }
    return { hostname: url.hostname, path: `${url.pathname}${url.search}` };
  }

  async function fetchOnce(uri: string): Promise<{ profile: PlatformProfile; ttl: number }> {
    const { hostname, path } = target(uri);

    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await resolve(hostname);
    } catch {
      throw unreachable('The profile host could not be resolved.');
    }
    if (answers.length === 0) throw unreachable('The profile host could not be resolved.');
    // Every answer must be public, not just the one we would use: a host that also answers with an
    // internal address is the shape of a rebinding attack.
    if (answers.some((a) => isSpecialUseAddress(a.address))) {
      throw unreachable('The profile host is not on the public internet.');
    }

    // Connect to the address we validated, never to the host name again.
    const { address, family } = answers[0]!;
    const { status, headers, body } = await new Promise<{
      status: number;
      headers: IncomingMessage['headers'];
      body: Buffer;
    }>((done, fail) => {
      const req = send(
        {
          host: address,
          family,
          port: 443,
          path,
          method: 'GET',
          servername: hostname, // SNI, and the name the certificate must match
          headers: {
            host: hostname,
            accept: 'application/json',
            'user-agent': 'OpenBooking-USP',
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              fail(unreachable('The profile is too large.'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', () => fail(unreachable('The profile could not be read.')));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        fail(unreachable('The profile took too long to answer.'));
      }, timeoutMs);
      req.on('timeout', () => {
        req.destroy();
        fail(unreachable('The profile took too long to answer.'));
      });
      req.on('error', () => fail(unreachable('The profile host could not be reached.')));
      req.on('close', () => clearTimeout(timer));
      req.end();
    });

    // 3xx is a failure, not something to follow: a redirect is how a public URL points inward.
    if (status !== 200) throw unreachable(`The profile answered HTTP ${status}.`);
    const contentType = String(headers['content-type'] ?? '').toLowerCase();
    if (!/^application\/(json|[\w.+-]+\+json)\b/.test(contentType)) {
      throw new ProtocolError('profile_malformed', 'The profile is not served as JSON.');
    }

    let parsed: PlatformProfile;
    try {
      parsed = PlatformProfileSchema.parse(JSON.parse(body.toString('utf8')));
    } catch {
      throw new ProtocolError(
        'profile_malformed',
        'The profile is not a valid USP platform profile.',
      );
    }
    const maxAge = /max-age=(\d+)/i.exec(String(headers['cache-control'] ?? ''));
    const ttl = Math.max(60, Math.min(3600, maxAge ? Number(maxAge[1]) : defaultTtl));
    return { profile: parsed, ttl };
  }

  function remember(uri: string, entry: Entry) {
    cache.delete(uri); // re-insert so the oldest entry is the first key
    cache.set(uri, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  }

  return async (uri: string) => {
    const hit = cache.get(uri);
    if (hit && hit.until > now()) {
      if ('error' in hit) throw hit.error;
      return hit.profile;
    }
    const running = inflight.get(uri);
    if (running) return running;

    const job = (async () => {
      try {
        const { profile, ttl } = await fetchOnce(uri);
        remember(uri, { profile, until: now() + ttl * 1000 });
        return profile;
      } catch (e) {
        // A bad URL is remembered briefly; a malformed URL needs no fetch to reject again.
        if (e instanceof ProtocolError && e.code !== 'invalid_profile_url') {
          remember(uri, { error: e, until: now() + failureTtl * 1000 });
        }
        throw e;
      }
    })().finally(() => inflight.delete(uri));
    inflight.set(uri, job);
    return job;
  };
}
