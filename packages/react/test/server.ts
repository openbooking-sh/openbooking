/** A real OpenBooking server on a local port, and a client that records what it sends. */
import { ManualClock } from '@openbooking-sh/core';
import { createClient, type OpenBookingClient } from '@openbooking-sh/client';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp, listen } from '@openbooking-sh/server';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// These tests talk to a real server over real HTTP, and the first one pays for its cold start.
// On a busy machine (CI, or the whole suite running at once) the defaults of 1 s to wait for a
// screen and 5 s per test are too short, which showed up as a test that only failed under load.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 15_000 });

/** A Friday more than 24 hours after the clock's start, so cancelling is free. */
export const DATE = '2026-10-16';

export interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface TestServer {
  clock: ManualClock;
  baseUrl: string;
  /** Every request the recording client sent, in order. */
  sent: Sent[];
  /** Make the next call to a path ending in `suffix` fail as if the network dropped. */
  dropNext(suffix: string): void;
  client: OpenBookingClient;
  close(): Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const clock = new ManualClock('2026-10-08T08:00:00Z');
  const { app } = createOpenBookingApp({
    provider: createDemoSalonProvider(),
    baseUrl: 'http://localhost:3000',
    serviceOptions: { clock },
  });
  const server = await listen(app, { port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}/book`;

  const sent: Sent[] = [];
  const drops: string[] = [];
  const realFetch = globalThis.fetch;
  const client = createClient({
    baseUrl,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      sent.push({
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^.*\/book\/api/, ''),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const at = drops.findIndex((suffix) => url.pathname.endsWith(suffix));
      if (at >= 0) {
        drops.splice(at, 1);
        throw new TypeError('network down');
      }
      return realFetch(input, init);
    },
  });

  return {
    clock,
    baseUrl,
    sent,
    dropNext: (suffix) => void drops.push(suffix),
    client,
    close: () => server.close(),
  };
}
