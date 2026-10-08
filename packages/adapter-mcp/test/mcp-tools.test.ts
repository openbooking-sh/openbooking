import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoRestaurantProvider } from '@openbooking-sh/provider-memory';
import { TOOL_NAMES, createMcpHttpHandler } from '../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(holdTtlSeconds = 300) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({
    provider: createDemoRestaurantProvider(),
    clock,
    holdTtlSeconds,
  });
  const handler = createMcpHttpHandler({ service });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
    await handler.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError === true, data: res.structuredContent as Record<string, any> };
  };
  return { client, call, clock };
}

describe('MCP adapter', () => {
  it('exposes exactly the agent tools with schemas and annotations', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const confirm = tools.find((t) => t.name === 'confirm_booking')!;
    expect(confirm.inputSchema.required).toEqual(
      expect.arrayContaining(['booking_id', 'user_confirmed', 'idempotency_key']),
    );
    expect(tools.find((t) => t.name === 'cancel_booking')!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'search_availability')!.annotations?.readOnlyHint).toBe(
      true,
    );
  });

  it('returns structured, actionable validation errors', async () => {
    const { call } = await connect();
    const res = await call('search_availability', { date: 'tomorrow', party_size: 2 });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatchObject({ code: 'validation_error' });
    expect(res.data.error.message).toContain('date');
    expect(res.data.error.suggested_next_action).toBeTruthy();
  });

  it('refuses to confirm without explicit user confirmation', async () => {
    const { call } = await connect();
    const search = await call('search_availability', {
      date: '2026-10-02',
      party_size: 2,
      time_from: '19:00',
    });
    const hold = await call('hold_slot', {
      slot_id: search.data.slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    expect(hold.data).toMatchObject({ status: 'held', expires_in_seconds: 300 });
    expect(hold.data.cancellation_policy.description).toContain('Free cancellation');
    const res = await call('confirm_booking', {
      booking_id: hold.data.booking_id,
      user_confirmed: false,
      idempotency_key: randomUUID(),
    });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe('user_confirmation_required');
  });

  it('reschedules a confirmed booking through MCP, with consent and a new booking_id', async () => {
    const { call } = await connect();
    const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
    const slots = async (time_from: string) =>
      (await call('search_availability', { date: '2026-10-02', party_size: 2, time_from })).data
        .slots;
    const hold = await call('hold_slot', {
      slot_id: (await slots('19:00'))[0].slot_id,
      idempotency_key: randomUUID(),
      customer,
    });
    const booked = await call('confirm_booking', {
      booking_id: hold.data.booking_id,
      user_confirmed: true,
      idempotency_key: randomUUID(),
    });
    expect(booked.data.status).toBe('confirmed');

    const target = (await slots('20:30')).find((s: any) => s.local_time >= '20:30');
    const args = { booking_id: booked.data.booking_id, new_slot_id: target.slot_id };
    const refused = await call('reschedule_booking', {
      ...args,
      user_confirmed: false,
      idempotency_key: randomUUID(),
    });
    expect(refused.data.error.code).toBe('user_confirmation_required');

    const moved = await call('reschedule_booking', {
      ...args,
      user_confirmed: true,
      idempotency_key: randomUUID(),
    });
    expect(moved.isError).toBe(false);
    expect(moved.data.status).toBe('confirmed');
    expect(moved.data.booking_id).not.toBe(booked.data.booking_id);
    expect(moved.data.local_time).toBe(target.local_time);
    expect(moved.data.previous).toMatchObject({
      booking_id: booked.data.booking_id,
      status: 'cancelled',
    });
    expect((await call('get_booking', { booking_id: booked.data.booking_id })).data.status).toBe(
      'cancelled',
    );
  });

  it('reports hold_expired with a recovery path', async () => {
    const { call, clock } = await connect(60);
    const search = await call('search_availability', { date: '2026-10-02', party_size: 2 });
    const hold = await call('hold_slot', {
      slot_id: search.data.slots[0].slot_id,
      idempotency_key: randomUUID(),
    });
    clock.advanceSeconds(61);
    const res = await call('confirm_booking', {
      booking_id: hold.data.booking_id,
      user_confirmed: true,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    expect(res.data.error.code).toBe('hold_expired');
    expect(res.data.error.suggested_next_action).toContain('search_availability');
  });
});
