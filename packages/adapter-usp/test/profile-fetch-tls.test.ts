/**
 * The fetcher connects to an address it validated, not to the host name, so the certificate has to
 * be checked against the NAME. These tests do a real TLS handshake with throwaway certificates:
 * connecting to 127.0.0.1 with the name `agent.example` must succeed only for a certificate that
 * is for `agent.example` and from an authority we trust.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfileFetcher, ProtocolError, USP_VERSION } from '../src';
import { platformProfile } from './platform-profile';

let dir = '';
let openssl = true;
const certs: Record<string, { key: string; cert: string }> = {};

function makeCert(name: string) {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync(
    'openssl',
    [
      ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1'],
      ...['-keyout', key, '-out', cert, '-subj', `/CN=${name}`],
      ...['-addext', `subjectAltName=DNS:${name}`],
    ],
    { stdio: 'ignore' },
  );
  certs[name] = { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'usp-tls-'));
  try {
    makeCert('agent.example');
    makeCert('other.example');
  } catch {
    openssl = false; // no openssl here: the tests below skip
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function serve(name: string): Promise<{ port: number; server: Server }> {
  const server = createServer(certs[name]!, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(platformProfile()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, server };
}

/** The fetcher, with DNS answering a public-looking address and the connection sent to us. */
function fetcher(port: number, trust?: string) {
  return createProfileFetcher({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    // The real https client with the options the fetcher built (servername and all). Only the
    // destination is changed, to our local server, and a trusted authority added for the test.
    httpsRequest: (opts, cb) =>
      httpsRequest({ ...opts, host: '127.0.0.1', port, ...(trust ? { ca: trust } : {}) }, cb),
  });
}

const URI = 'https://agent.example/profile.json';

describe('TLS to a validated address', () => {
  const when = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!openssl) ctx.skip();
      await fn();
    });

  when('accepts a certificate for the host name, though it connected to an address', async () => {
    const { port, server } = await serve('agent.example');
    try {
      const profile = await fetcher(port, certs['agent.example']!.cert)(URI);
      expect(profile.usp.version).toBe(USP_VERSION);
    } finally {
      server.close();
    }
  });

  when('refuses a certificate that is for a different name', async () => {
    const { port, server } = await serve('other.example'); // valid, trusted, and for someone else
    try {
      await expect(fetcher(port, certs['other.example']!.cert)(URI)).rejects.toMatchObject({
        code: 'profile_unreachable',
      });
    } finally {
      server.close();
    }
  });

  when('refuses a certificate from an authority we do not trust', async () => {
    const { port, server } = await serve('agent.example');
    try {
      // No `ca`: a self-signed certificate must not be accepted.
      const err = await fetcher(port)(URI).catch((e) => e);
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe('profile_unreachable');
    } finally {
      server.close();
    }
  });
});
