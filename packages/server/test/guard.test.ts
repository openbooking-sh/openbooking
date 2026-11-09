/**
 * Anti-scalping end to end: a real MCP client over the Hono app. Limits refuse with a clear next
 * step, and broker flags reach the venue's staff (Studio) but never any response an agent or a
 * guest can read.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ManualClock } from '@openbooking-sh/core';
import { createDemoRestaurantProvider } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp, type OpenBookingServerOptions } from '../src';

const BASE = 'http://localhost:3000';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeApp(guard: NonNullable<OpenBookingServerOptions['serviceOptions']>['guard']) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const ob = createOpenBookingApp({
    provider: createDemoRestaurantProvider(),
    baseUrl: BASE,
    serviceOptions: { clock, holdTtlSeconds: 300, ...(guard ? { guard } : {}) },
    studio: { token: 'studio-token' },
  });
  cleanups.push(ob.close);
  return ob;
}

async function mcp(app: ReturnType<typeof makeApp>['app'], name = 'broker-bot') {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', new URL(url).host);
      return app.fetch(new Request(url, { ...init, headers }));
    },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const seen: string[] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: tool, arguments: args });
    seen.push(JSON.stringify(res));
    return { error: !!res.isError, body: res.structuredContent as Record<string, any> };
  };
  return { call, seen };
}

const DAY = '2026-10-02';

describe('anti-scalping over MCP', () => {
  it('refuses past the guest limit with a next step that names no number', async () => {
    const ob = makeApp({ guest: { maxActive: 1 } });
    const { call } = await mcp(ob.app);
    const search = await call('search_availability', {
      date: DAY,
      party_size: 2,
      time_from: '17:00',
      time_to: '21:00',
    });
    const [first, second] = search.body.slots;
    const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
    const hold = await call('hold_slot', {
      slot_id: first.slot_id,
      idempotency_key: randomUUID(),
      customer,
    });
    expect(hold.error).toBe(false);

    const refused = await call('hold_slot', {
      slot_id: second.slot_id,
      idempotency_key: randomUUID(),
      customer,
    });
    expect(refused.error).toBe(true);
    const error = refused.body.error;
    expect(error.code).toBe('booking_limit_reached');
    expect(error.suggested_next_action).toMatch(/contact the venue/i);
    expect(JSON.stringify(error)).not.toMatch(/\b1\b/);
  });

  it('keeps risk flags out of every agent-facing response, and shows them to Studio', async () => {
    const ob = makeApp({ flags: { contact_many_names: { count: 2, window_hours: 24 } } });
    const { call, seen } = await mcp(ob.app);
    const search = await call('search_availability', {
      date: DAY,
      party_size: 2,
      time_from: '17:00',
      time_to: '21:00',
    });
    const ids: string[] = [];
    for (const [i, name] of ['Ada', 'Grace'].entries()) {
      const hold = await call('hold_slot', {
        slot_id: search.body.slots[i].slot_id,
        idempotency_key: randomUUID(),
        customer: { first_name: name, last_name: 'Broker', email: 'broker@example.com' },
      });
      const confirmed = await call('confirm_booking', {
        booking_id: hold.body.booking_id,
        user_confirmed: true,
        idempotency_key: randomUUID(),
      });
      expect(confirmed.error).toBe(false);
      await call('get_booking', { booking_id: hold.body.booking_id });
      ids.push(hold.body.booking_id);
    }

    // Not refused, not flagged in anything the agent saw.
    const everything = seen.join('\n');
    expect(everything).not.toMatch(/risk|flag|contact_many_names/i);
    expect(everything).not.toMatch(/"e:[0-9a-f]{8}/);

    // The guest-facing booking page API does not carry them either.
    const page = await ob.app.request(`/book/api/bookings/${ids[1]}`);
    const pageText = await page.text();
    expect(pageText).not.toMatch(/risk|contact_many_names/i);

    // Staff see them in Studio.
    const studio = await ob.app.request('/studio/api/bookings', {
      headers: { authorization: 'Bearer studio-token' },
    });
    const { bookings } = (await studio.json()) as {
      bookings: Array<{ booking_id: string; risk_flags?: string[] }>;
    };
    const byId = new Map(bookings.map((b) => [b.booking_id, b.risk_flags]));
    expect(byId.get(ids[0]!)).toBeUndefined();
    expect(byId.get(ids[1]!)).toEqual(['contact_many_names']);
  });

  it('says in the terms and on the confirmation that the booking is not transferable', async () => {
    const ob = makeApp({ nonTransferable: true });
    const { call } = await mcp(ob.app);
    const search = await call('search_availability', {
      date: DAY,
      party_size: 2,
      time_from: '17:00',
      time_to: '21:00',
    });
    expect(search.body.slots[0].cancellation_policy.description).toMatch(/cannot be transferred/);
    const hold = await call('hold_slot', {
      slot_id: search.body.slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    const confirmed = await call('confirm_booking', {
      booking_id: hold.body.booking_id,
      user_confirmed: true,
      idempotency_key: randomUUID(),
    });
    expect(confirmed.body.cancellation_policy.description).toMatch(/cannot be transferred/);

    // A hold named Ada cannot be confirmed for someone else.
    const second = await call('hold_slot', {
      slot_id: search.body.slots[1].slot_id,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    const rename = await call('confirm_booking', {
      booking_id: second.body.booking_id,
      user_confirmed: true,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Someone', last_name: 'Else', email: 'else@example.com' },
    });
    expect(rename.error).toBe(true);
    expect(rename.body.error.code).toBe('not_transferable');
  });
});
