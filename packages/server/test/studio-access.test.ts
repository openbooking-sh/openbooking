/**
 * Studio without a token is for local development only. A localhost baseUrl is also what a
 * deployed app ends up with when BASE_URL was never set, so these start real servers and check
 * that Studio stays locked for anyone who is not on this machine.
 */
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp, listen } from '../src';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The app a scaffold builds when BASE_URL is missing: localhost, no Studio token. */
async function start(hostname = '127.0.0.1') {
  const ob = createOpenBookingApp({
    provider: createDemoSalonProvider(),
    baseUrl: 'http://localhost:3000',
  });
  const server = await listen(ob.app, { port: 0, hostname });
  cleanups.push(ob.close, server.close);
  return { ob, port: server.port };
}

/** A raw request, so the Host header can be forged the way an attacker would. */
function get(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

describe('Studio without a token', () => {
  it('opens for a browser on this machine', async () => {
    const { port } = await start();
    expect(await get('127.0.0.1', port, '/studio/api/session', { host: `localhost:${port}` })).toBe(
      200,
    );
    expect(
      await get('127.0.0.1', port, '/studio/api/customers', { host: `127.0.0.1:${port}` }),
    ).toBe(200);
  });

  it('is locked for a request that came through a proxy or tunnel', async () => {
    const { port } = await start();
    for (const header of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via']) {
      const status = await get('127.0.0.1', port, '/studio/api/customers', {
        host: `localhost:${port}`,
        [header]: '203.0.113.9',
      });
      expect(status, header).toBe(401);
    }
  });

  it('is locked when the request names another host', async () => {
    const { port } = await start();
    expect(
      await get('127.0.0.1', port, '/studio/api/customers', { host: 'book.example.com' }),
    ).toBe(401);
  });

  it.skipIf(!lanAddress)(
    'is locked for another machine, even one that forges the Host header',
    async () => {
      // What a host does: listen on every interface. The caller arrives from a non-loopback address.
      const { port } = await start('0.0.0.0');
      expect(
        await get(lanAddress!, port, '/studio/api/customers', { host: `localhost:${port}` }),
      ).toBe(401);
      expect(
        await get(lanAddress!, port, '/studio/api/bookings/x/cancel', {
          host: `localhost:${port}`,
        }),
      ).toBe(401);
      // The same server still answers its own machine.
      expect(
        await get('127.0.0.1', port, '/studio/api/session', { host: `localhost:${port}` }),
      ).toBe(200);
    },
  );

  it('is locked for a non-loopback socket address', async () => {
    const ob = createOpenBookingApp({
      provider: createDemoSalonProvider(),
      baseUrl: 'http://localhost:3000',
    });
    cleanups.push(ob.close);
    const from = (remoteAddress: string) =>
      ob.app.fetch(new Request('http://localhost:3000/studio/api/customers'), {
        incoming: { socket: { remoteAddress } },
      });
    expect((await from('10.0.0.5')).status).toBe(401);
    expect((await from('::ffff:172.17.0.1')).status).toBe(401);
    expect((await from('::ffff:127.0.0.1')).status).toBe(200);
    expect((await from('::1')).status).toBe(200);
  });

  it.each([
    ['NODE_ENV', 'production'],
    ['RAILWAY_ENVIRONMENT', 'production'],
    ['FLY_APP_NAME', 'my-salon'],
    ['RENDER', 'true'],
  ])('is locked at start when %s says this is a deployment, and says why', async (name, value) => {
    vi.stubEnv(name, value);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { port } = await start();
    expect(await get('127.0.0.1', port, '/studio/api/session', { host: `localhost:${port}` })).toBe(
      401,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('Studio is locked');
    expect(warn.mock.calls[0]![0]).toContain(name);
  });

  it('a token still works anywhere, and no warning is logged', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ob = createOpenBookingApp({
      provider: createDemoSalonProvider(),
      baseUrl: 'http://localhost:3000',
      studio: { token: 'studio-test-token' },
    });
    cleanups.push(ob.close);
    const res = await ob.app.request('/studio/api/session', {
      headers: { authorization: 'Bearer studio-test-token', 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });
});
