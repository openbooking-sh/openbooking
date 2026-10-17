/**
 * USP's MCP binding mounted in the full server, over real sockets: the official MCP client does a
 * real handshake against `/usp/mcp`, a platform holds and books with MCP-form proofs signed by its
 * own key, and the customer's click on the real confirm page is what makes the booking real.
 */
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, type BookingEvent } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { USP, USP_VERSION, type ProfileFetcher } from '@openbooking-sh/adapter-usp';
import { createOpenBookingApp, type OpenBookingServerOptions } from '../src';

const BASE = 'http://localhost:3000';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(extra: Partial<OpenBookingServerOptions> = {}) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const events: BookingEvent[] = [];
  const ob = createOpenBookingApp({
    provider: createDemoSalonProvider(),
    baseUrl: BASE,
    serviceOptions: { clock, onEvent: (e) => events.push(e) },
    ...extra,
  });
  const server = serve({ fetch: ob.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(ob.close, () => {
    server.close();
  });
  return { ...ob, clock, events, url };
}

const profiles: ProfileFetcher = async () => {
  const entry = [{ version: USP_VERSION }];
  return {
    usp: {
      version: USP_VERSION,
      capabilities: { [USP.catalog]: entry, [USP.availability]: entry, [USP.bookings]: entry },
    },
  };
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');
const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const PROFILE = 'https://agents.perplexity.ai/profile.json';

/** Canonical JSON (RFC 8785 for the plain values used here), written independently of the adapter. */
function jcs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

async function mcpPlatform(w: { url: string; clock: ManualClock }) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const client = new Client({ name: 'perplexity-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${w.url}/usp/mcp`)));
  cleanups.push(() => client.close());
  let n = 0;
  return {
    jkt: await calculateJwkThumbprint(jwk),
    client,
    async call(tool: string, args: Record<string, unknown>, opts: { credential?: string } = {}) {
      const usp: Record<string, unknown> = {
        profile: PROFILE,
        idempotency_key: crypto.randomUUID(),
      };
      const full = { ...args, _meta: { usp } };
      // usp_p covers the arguments with only _meta.usp.authorization removed.
      const proof = await new SignJWT({
        usp_m: tool,
        aud: `${BASE}/.well-known/usp`,
        usp_p: sha256(jcs(full)),
        iat: Math.floor(w.clock.now().getTime() / 1000),
        jti: `mcp-${++n}-${Math.random().toString(36).slice(2)}`,
        ...(opts.credential ? { ath: sha256(opts.credential) } : {}),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'usp-pop+jwt', jwk })
        .sign(privateKey);
      usp.authorization = {
        mechanism: opts.credential ? 'booking_scoped_credential' : 'platform_key_pop',
        ...(opts.credential ? { credential: opts.credential } : {}),
        proof,
      };
      return client.callTool({ name: tool, arguments: full });
    },
  };
}

describe('USP MCP binding in the server', () => {
  it('is off unless asked for, even when USP is on', async () => {
    const w = await boot({ usp: { platformProfiles: profiles } });
    const res = await fetch(`${w.url}/usp/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const profile = (await (await fetch(`${w.url}/.well-known/usp`)).json()) as any;
    expect(profile.usp.services['dev.usp-protocol.services']).toHaveLength(1);
    const index = (await (
      await fetch(`${w.url}/`, { headers: { accept: 'application/json' } })
    ).json()) as any;
    expect(index.protocols.usp.mcp_endpoint).toBeUndefined();
  });

  it('does a real handshake, holds with a signed proof, and books only when the customer confirms on the page', async () => {
    const w = await boot({ usp: { platformProfiles: profiles, mcp: true } });
    const profile = (await (await fetch(`${w.url}/.well-known/usp`)).json()) as any;
    expect(
      profile.usp.services['dev.usp-protocol.services'].find((s: any) => s.transport === 'mcp')
        .endpoint,
    ).toBe(`${BASE}/usp/mcp`);
    const index = (await (
      await fetch(`${w.url}/`, { headers: { accept: 'application/json' } })
    ).json()) as any;
    expect(index.protocols.usp.mcp_endpoint).toBe(`${BASE}/usp/mcp`);

    const assistant = await mcpPlatform(w);
    const { tools } = await assistant.client.listTools();
    expect(tools.map((t) => t.name)).toContain('usp_bookings_create');

    const search = await assistant.client.callTool({
      name: 'usp_availability_query',
      arguments: {
        service_id: 'haircut',
        start_date: '2026-10-16',
        end_date: '2026-10-16',
        resource_id: 'maria',
        limit: 1,
      },
    });
    const slot = (search.structuredContent as any).slots[0] as { id: string };

    const held = (
      await assistant.call('usp_availability_hold', {
        slot_id: slot.id,
        service_id: 'haircut',
      })
    ).structuredContent as any;
    expect(held.hold.status).toBe('active');

    const created = (
      await assistant.call('usp_bookings_create', {
        service_id: 'haircut',
        slot_id: slot.id,
        hold_id: held.hold.id,
        buyer: BUYER,
      })
    ).structuredContent as any;
    const booking = created.booking;
    expect(booking.status).toBe('requires_action');
    expect(booking.actions[0].continue_url).toBe(`${BASE}/book/confirm/${booking.id}`);
    expect(created.booking_scoped_credential.cnf.jkt).toBe(assistant.jkt);
    // The engine agrees: it is only held.
    expect((await w.service.getBooking(booking.id)).status).toBe('held');

    // The customer presses the button on the real page.
    const page = await fetch(`${w.url}/book/confirm/${booking.id}`);
    expect(await page.text()).toContain('Nothing is booked until you confirm it here');
    const confirm = await fetch(`${w.url}/book/api/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        booking_id: booking.id,
        idempotency_key: 'customer-click-mcp',
        user_confirmed: true,
      }),
    });
    expect(confirm.status).toBe(200);

    const done = (
      await assistant.call(
        'usp_bookings_get',
        { booking_id: booking.id },
        { credential: created.booking_scoped_credential.value },
      )
    ).structuredContent as any;
    expect(done.booking.status).toBe('confirmed');

    // A call without a proof is a JSON-RPC error with the USP code, and changes nothing.
    await expect(
      assistant.client.callTool({
        name: 'usp_bookings_cancel',
        arguments: {
          booking_id: booking.id,
          _meta: { usp: { profile: PROFILE, idempotency_key: 'k' } },
        },
      }),
    ).rejects.toMatchObject({ data: { code: 'pop_proof_missing' } });
    expect((await w.service.getBooking(booking.id)).status).toBe('confirmed');

    // Studio sees the channel as USP.
    const viaUsp = w.events.filter((e) => e.actor?.protocol === 'usp' && e.operation !== 'search');
    expect(viaUsp.length).toBeGreaterThan(0);
  });
});
