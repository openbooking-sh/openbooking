/**
 * End-to-end: a real MCP client talks to the full Hono app (in-process, no socket) and completes
 * search → hold → confirm → cancel. Runs against both MCP protocol eras the SDK serves.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ManualClock } from '@openbooking/core';
import { createDemoRestaurantProvider } from '@openbooking/provider-memory';
import { createOpenBookingApp } from '../src';

const BASE = 'http://localhost:3000';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeApp() {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const provider = createDemoRestaurantProvider();
  const ob = createOpenBookingApp({
    provider,
    baseUrl: BASE,
    serviceOptions: { clock, holdTtlSeconds: 300 },
  });
  cleanups.push(ob.close);
  return { ...ob, clock, provider };
}

async function mcpClient(app: ReturnType<typeof makeApp>['app'], mode: 'legacy' | 'auto') {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    // In-process requests carry no Host header (real HTTP always does); set it like a socket would.
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', new URL(url).host);
      return app.fetch(new Request(url, { ...init, headers }));
    },
  });
  const client = new Client(
    { name: 'integration-test', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  cleanups.push(() => client.close());
  expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.structuredContent)}`);
    return res.structuredContent as Record<string, any>;
  };
}

describe.each(['legacy', 'auto'] as const)('MCP end-to-end (%s era)', (mode) => {
  it('completes search → hold → confirm → cancel without double booking', async () => {
    const { app, provider, clock } = makeApp();
    const call = await mcpClient(app, mode);

    const search = await call('search_availability', {
      date: '2026-10-02',
      party_size: 4,
      time_from: '19:00',
      time_to: '20:00',
    });
    expect(search.venue.name).toBe('Demo Bistro Oslo');
    expect(search.slots.length).toBeGreaterThan(0);
    const slot = search.slots[0];
    expect(slot.cancellation_policy.description).toBeTruthy();

    const holdKey = randomUUID();
    const hold = await call('hold_slot', {
      slot_id: slot.slot_id,
      idempotency_key: holdKey,
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    expect(hold.status).toBe('held');
    expect(hold.expires_at).toBeTruthy();
    expect(hold.next_step).toContain('confirm_booking');

    // An agent retrying the hold (e.g. after a timeout) gets the same booking back.
    const retry = await call('hold_slot', {
      slot_id: slot.slot_id,
      idempotency_key: holdKey,
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    expect(retry.booking_id).toBe(hold.booking_id);

    const confirmKey = randomUUID();
    const confirmed = await call('confirm_booking', {
      booking_id: hold.booking_id,
      user_confirmed: true,
      idempotency_key: confirmKey,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmation_code).toMatch(/^[A-Z0-9]{6}$/);
    expect(confirmed.expires_at).toBeNull();

    const again = await call('confirm_booking', {
      booking_id: hold.booking_id,
      user_confirmed: true,
      idempotency_key: confirmKey,
    });
    expect(again.confirmation_code).toBe(confirmed.confirmation_code);

    const fetched = await call('get_booking', { booking_id: hold.booking_id });
    expect(fetched.status).toBe('confirmed');

    const cancelled = await call('cancel_booking', {
      booking_id: hold.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
      reason: 'Plans changed',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellation).toMatchObject({ fee: null });

    const bookings = await provider.inspectBookings(clock.now());
    expect(bookings).toHaveLength(1);
    expect(await provider.findOverlaps(clock.now())).toEqual([]);
  });
});

describe('discovery documents', () => {
  it('serves /.well-known/ucp, the agent card and an index', async () => {
    const { app } = makeApp();
    const ucp = (await (await app.request('/.well-known/ucp')).json()) as any;
    expect(ucp.ucp.services['dev.ucp.lodging'][0].endpoint).toBe(`${BASE}/ucp`);

    const res = await app.request('/.well-known/agent-card.json');
    expect(res.headers.get('cache-control')).toContain('max-age');
    const card = (await res.json()) as any;
    expect(card.supportedInterfaces[0].url).toBe(`${BASE}/a2a`);
    expect(card.capabilities.extensions[0].params.url).toBe(`${BASE}/mcp`);

    const index = (await (await app.request('/')).json()) as any;
    expect(index.protocols).toMatchObject({
      mcp: { status: 'supported' },
      ucp: { status: 'draft' },
      a2a: { status: 'stub' },
    });
  });

  it('rejects MCP requests with a foreign Host header (DNS rebinding protection)', async () => {
    const { app } = makeApp();
    const res = await app.fetch(
      new Request('http://evil.example/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('Studio attribution end-to-end', () => {
  it.each(['legacy', 'auto'] as const)(
    'credits an MCP booking to the calling assistant (%s era)',
    async (mode) => {
      const clock = new ManualClock('2026-10-01T08:00:00Z');
      const ob = createOpenBookingApp({
        provider: createDemoRestaurantProvider(),
        baseUrl: BASE,
        serviceOptions: { clock },
        studio: { token: 'studio-test-token' },
      });
      cleanups.push(ob.close);
      const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('host', new URL(url).host);
          // Legacy-era tool calls carry no clientInfo; real assistants identify via User-Agent.
          headers.set('user-agent', 'Claude-User/1.0');
          return ob.app.fetch(new Request(url, { ...init, headers }));
        },
      });
      const client = new Client(
        { name: 'claude-ai', version: '1.0.0' },
        { versionNegotiation: { mode } },
      );
      await client.connect(transport);
      cleanups.push(() => client.close());

      const search = (
        await client.callTool({
          name: 'search_availability',
          arguments: { date: '2026-10-02', party_size: 2, time_from: '19:00' },
        })
      ).structuredContent as any;
      const hold = (
        await client.callTool({
          name: 'hold_slot',
          arguments: {
            slot_id: search.slots[0].slot_id,
            idempotency_key: randomUUID(),
            customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
          },
        })
      ).structuredContent as any;
      await client.callTool({
        name: 'confirm_booking',
        arguments: {
          booking_id: hold.booking_id,
          user_confirmed: true,
          idempotency_key: randomUUID(),
        },
      });

      const res = await ob.app.request('/studio/api/overview', {
        headers: { authorization: 'Bearer studio-test-token' },
      });
      const overview = (await res.json()) as any;
      expect(overview.agents[0]).toMatchObject({ agent: 'Claude', bookings: 1, holds: 1 });
      expect(overview.recent_bookings[0]).toMatchObject({
        status: 'confirmed',
        booked_via: 'Claude',
      });
    },
  );
});

describe('Studio routing', () => {
  it('serves the Studio at /studio and redirects /studio/', async () => {
    const ob = createOpenBookingApp({ provider: createDemoRestaurantProvider(), baseUrl: BASE });
    cleanups.push(ob.close);
    const page = await ob.app.request('/studio');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('OpenBooking Studio');
    const slash = await ob.app.request('/studio/');
    expect(slash.status).toBe(302);
    expect(slash.headers.get('location')).toBe('/studio');
    // localhost baseUrl → dev mode without token.
    expect((await ob.app.request('/studio/api/session')).status).toBe(200);
  });

  it('locks the Studio on a public baseUrl without a token', async () => {
    const ob = createOpenBookingApp({
      provider: createDemoRestaurantProvider(),
      baseUrl: 'https://bistro.example',
    });
    cleanups.push(ob.close);
    expect((await ob.app.request('/studio/api/session')).status).toBe(401);
  });
});

describe('booking page', () => {
  it('serves the booking page to browsers at / and JSON to everyone else', async () => {
    const { app } = makeApp();
    const html = await app.request('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(html.headers.get('content-type')).toContain('text/html');
    const page = await html.text();
    expect(page).toContain('Demo Bistro Oslo');
    expect(page).toContain(`<link rel="canonical" href="${BASE}/book" />`);

    const index = (await (
      await app.request('/', { headers: { accept: 'application/json' } })
    ).json()) as any;
    expect(index.booking_page).toBe(`${BASE}/book`);
    expect(index.protocols.mcp.status).toBe('supported');

    const info = (await (await app.request('/book/api/info')).json()) as any;
    expect(info.venue.name).toBe('Demo Bistro Oslo');
    expect((await app.request('/book')).status).toBe(200);
  });

  it('can be turned off', async () => {
    const ob = createOpenBookingApp({
      provider: createDemoRestaurantProvider(),
      baseUrl: BASE,
      bookingPage: false,
    });
    cleanups.push(ob.close);
    const res = await ob.app.request('/', { headers: { accept: 'text/html' } });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as any).booking_page).toBeUndefined();
    expect((await ob.app.request('/book')).status).toBe(404);
  });
});
