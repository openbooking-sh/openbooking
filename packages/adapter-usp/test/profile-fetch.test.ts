/**
 * The profile fetcher is where a platform makes our server send a request, so these tests are
 * mostly about what it refuses. A real HTTP server stands behind a swapped-in client, so redirects,
 * size, speed and content types are exercised for real; DNS and the address connected to are
 * observed rather than trusted.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestOptions } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfileFetcher, isSpecialUseAddress, ProtocolError, USP_VERSION } from '../src';
import { platformProfile } from './platform-profile';

describe('isSpecialUseAddress', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // the cloud metadata address
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.5',
    '203.0.113.9',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', // IPv4 written as IPv6
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', // 169.254.169.254
    '64:ff9b::7f00:1', // NAT64 to 127.0.0.1
    '2002:7f00:1::', // 6to4 of 127.0.0.1
    'not-an-ip',
    '',
  ];
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255', // just outside 172.16.0.0/12
    '172.32.0.1',
    '100.63.255.255', // just outside 100.64.0.0/10
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001::1',
    '::ffff:8.8.8.8',
  ];
  it.each(blocked)('blocks %s', (address) => {
    expect(isSpecialUseAddress(address)).toBe(true);
  });
  it.each(allowed)('allows the public address %s', (address) => {
    expect(isSpecialUseAddress(address)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A real server behind the fetcher
// ---------------------------------------------------------------------------

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  delayMs?: number;
};
let server: Server;
let port = 0;
let reply: Reply = {};
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    const send = () => {
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers,
      });
      res.end(reply.body ?? JSON.stringify(platformProfile()));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const URI = 'https://agent.example/profile.json';
const PUBLIC_IP = '93.184.216.34';

/** A fetcher whose DNS and TLS client are replaced; `seen` records what it tried to connect to. */
function fetcher(
  options: {
    answers?: Array<{ address: string; family: number }>;
    resolveError?: boolean;
    now?: () => number;
    timeoutMs?: number;
    maxBytes?: number;
    maxEntries?: number;
  } = {},
) {
  const seen: RequestOptions[] = [];
  let resolved = 0;
  const fetch = createProfileFetcher({
    resolve: async () => {
      resolved++;
      if (options.resolveError) throw new Error('ENOTFOUND');
      return options.answers ?? [{ address: PUBLIC_IP, family: 4 }];
    },
    // The real https client, except that the connection goes to our local server.
    httpsRequest: (opts, cb: (res: IncomingMessage) => void) => {
      seen.push(opts);
      return httpRequest(
        { host: '127.0.0.1', port, path: opts.path, method: opts.method, headers: opts.headers },
        cb,
      );
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxEntries ? { maxEntries: options.maxEntries } : {}),
  });
  return { fetch, seen, resolved: () => resolved };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return (e as ProtocolError).code;
  }
  throw new Error('expected a refusal');
};

describe('fetching a profile', () => {
  it('returns the profile, connecting to the address it validated, with the host name for TLS', async () => {
    reply = {};
    const f = fetcher();
    const profile = await f.fetch(URI);
    expect(profile.usp.version).toBe(USP_VERSION);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({
      host: PUBLIC_IP, // the validated address, not the name
      port: 443,
      servername: 'agent.example', // SNI and certificate name
      path: '/profile.json',
      method: 'GET',
      headers: expect.objectContaining({ host: 'agent.example' }),
    });
  });

  it('resolves the name once, so a second answer cannot redirect the connection (rebinding)', async () => {
    reply = {};
    const f = fetcher();
    await f.fetch(URI);
    expect(f.resolved()).toBe(1);
  });

  it('caches by URI, for at least 60 seconds whatever the profile asks for', async () => {
    let now = 1_000_000;
    reply = { headers: { 'cache-control': 'max-age=5' } };
    hits = 0;
    const f = fetcher({ now: () => now });
    await f.fetch(URI);
    now += 59_000;
    await f.fetch(URI);
    expect(hits).toBe(1);
    now += 2_000; // 61 seconds in: past the minimum
    await f.fetch(URI);
    expect(hits).toBe(2);
  });

  it('keeps a profile for as long as its Cache-Control says', async () => {
    let now = 1_000_000;
    reply = { headers: { 'cache-control': 'public, max-age=600' } };
    hits = 0;
    const f = fetcher({ now: () => now });
    await f.fetch(URI);
    now += 599_000;
    await f.fetch(URI);
    expect(hits).toBe(1);
    now += 2_000;
    await f.fetch(URI);
    expect(hits).toBe(2);
  });

  it('shares one fetch between concurrent requests for the same URI', async () => {
    reply = { delayMs: 50 };
    hits = 0;
    const f = fetcher();
    await Promise.all([f.fetch(URI), f.fetch(URI), f.fetch(URI)]);
    expect(hits).toBe(1);
  });

  it('keeps the cache bounded', async () => {
    reply = {};
    hits = 0;
    const f = fetcher({ maxEntries: 2 });
    await f.fetch('https://one.example/p.json');
    await f.fetch('https://two.example/p.json');
    await f.fetch('https://three.example/p.json'); // evicts the first
    await f.fetch('https://one.example/p.json');
    expect(hits).toBe(4);
  });
});

describe('what it refuses', () => {
  it('refuses a host that resolves to a private address, without connecting', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '169.254.169.254',
      '::1',
      '::ffff:192.168.0.1',
    ]) {
      const f = fetcher({ answers: [{ address, family: address.includes(':') ? 6 : 4 }] });
      expect(await code(f.fetch(URI))).toBe('profile_unreachable');
      expect(f.seen).toEqual([]);
    }
  });

  it('refuses a host that answers with a public address AND a private one', async () => {
    const f = fetcher({
      answers: [
        { address: PUBLIC_IP, family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect(await code(f.fetch(URI))).toBe('profile_unreachable');
    expect(f.seen).toEqual([]);
  });

  it('refuses a host that does not resolve', async () => {
    expect(await code(fetcher({ resolveError: true }).fetch(URI))).toBe('profile_unreachable');
    expect(await code(fetcher({ answers: [] }).fetch(URI))).toBe('profile_unreachable');
  });

  it.each([
    'http://agent.example/p.json', // not https
    'https://agent.example:8443/p.json', // not port 443
    'https://user:pass@agent.example/p.json', // credentials
    'https://agent.example/p.json#frag',
    'https://127.0.0.1/p.json', // IP literals, whatever they point at
    'https://8.8.8.8/p.json',
    'https://[::1]/p.json',
    'https://localhost/p.json', // single-label host
    'file:///etc/passwd',
    'not a url',
  ])('refuses the URL %s before any lookup or connection', async (uri) => {
    const f = fetcher();
    expect(await code(f.fetch(uri))).toBe('invalid_profile_url');
    expect(f.resolved()).toBe(0);
    expect(f.seen).toEqual([]);
  });

  it('does not follow a redirect', async () => {
    reply = { status: 302, headers: { location: 'https://internal.example/secret' } };
    hits = 0;
    const f = fetcher();
    expect(await code(f.fetch(URI))).toBe('profile_unreachable');
    expect(hits).toBe(1);
    expect(f.seen).toHaveLength(1);
  });

  it('refuses a profile that is too large', async () => {
    reply = { body: JSON.stringify({ ...platformProfile(), padding: 'x'.repeat(5000) }) };
    expect(await code(fetcher({ maxBytes: 1024 }).fetch(URI))).toBe('profile_unreachable');
  });

  it('gives up on a host that is too slow', async () => {
    reply = { delayMs: 1000 };
    expect(await code(fetcher({ timeoutMs: 150 }).fetch(URI))).toBe('profile_unreachable');
  });

  it('refuses a non-200 answer', async () => {
    reply = { status: 404, body: 'nope' };
    expect(await code(fetcher().fetch(URI))).toBe('profile_unreachable');
  });

  it('calls a profile that is not JSON, or not a USP profile, malformed', async () => {
    const malformed = async (r: Reply) => {
      reply = r;
      return code(fetcher().fetch(URI));
    };
    expect(await malformed({ headers: { 'content-type': 'text/html' }, body: '<html>' })).toBe(
      'profile_malformed',
    );
    expect(await malformed({ body: '{not json' })).toBe('profile_malformed');
    expect(await malformed({ body: '[]' })).toBe('profile_malformed');
    expect(await malformed({ body: JSON.stringify({ usp: { version: 'soon' } }) })).toBe(
      'profile_malformed',
    );
    expect(
      await malformed({
        body: JSON.stringify({
          usp: { version: USP_VERSION, capabilities: { x: [{ version: 'v1' }] } },
        }),
      }),
    ).toBe('profile_malformed');
  });

  it('accepts a +json content type', async () => {
    reply = { headers: { 'content-type': 'application/ld+json; charset=utf-8' } };
    expect((await fetcher().fetch(URI)).usp.version).toBe(USP_VERSION);
  });

  it('remembers a failure briefly, so a bad URL cannot be used to hammer a host', async () => {
    let now = 1_000_000;
    reply = { status: 500, body: 'oops' };
    hits = 0;
    const f = fetcher({ now: () => now });
    await code(f.fetch(URI));
    await code(f.fetch(URI));
    expect(hits).toBe(1);
    now += 31_000;
    reply = {};
    expect((await f.fetch(URI)).usp.version).toBe(USP_VERSION); // retried, and recovered
    expect(hits).toBe(2);
  });
});
