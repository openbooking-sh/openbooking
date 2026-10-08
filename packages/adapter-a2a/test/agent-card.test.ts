import { describe, expect, it } from 'vitest';
import { ManualClock, BookingService } from '@openbooking-sh/core';
import { createDemoRestaurantProvider } from '@openbooking-sh/provider-memory';
import { buildAgentCard, createA2AAdapter } from '../src';

describe('A2A Agent Card', () => {
  it('contains every v1.0 required field and no removed v0.3 fields', () => {
    const card = buildAgentCard({
      name: 'Demo Bistro',
      description: 'Book a table',
      baseUrl: 'https://bistro.example/',
      mcpUrl: 'https://bistro.example/mcp',
    });
    for (const field of [
      'name',
      'description',
      'supportedInterfaces',
      'version',
      'capabilities',
      'defaultInputModes',
      'defaultOutputModes',
      'skills',
    ]) {
      expect(card).toHaveProperty(field);
    }
    expect(card.supportedInterfaces[0]).toEqual({
      url: 'https://bistro.example/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    });
    for (const removed of [
      'url',
      'protocolVersion',
      'preferredTransport',
      'additionalInterfaces',
    ]) {
      expect(card).not.toHaveProperty(removed);
    }
    for (const skill of card.skills) {
      expect(skill.id && skill.name && skill.description && skill.tags.length).toBeTruthy();
    }
  });
});

describe('A2A SendMessage', () => {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({ provider: createDemoRestaurantProvider(), clock });
  const a2a = createA2AAdapter({ service });
  let n = 0;
  const call = async (method: string, params: unknown) => {
    const res = await a2a.fetch(
      new Request('http://x/a2a', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      }),
    );
    return (await res.json()) as any;
  };
  const skill = async (data: Record<string, unknown>) => {
    const r = await call('SendMessage', {
      message: {
        messageId: 'm' + n,
        role: 'ROLE_USER',
        parts: [{ data, mediaType: 'application/json' }],
      },
    });
    expect(r.result.message.role).toBe('ROLE_AGENT');
    return r.result.message.parts[0].data;
  };

  it('completes search, hold, confirm, with the consent gate enforced', async () => {
    const found = await skill({ skill: 'search_availability', date: '2026-10-09', party_size: 2 });
    expect(found.slots.length).toBeGreaterThan(0);
    const held = await skill({
      skill: 'hold_slot',
      slot_id: found.slots[0].slot_id,
      idempotency_key: crypto.randomUUID(),
    });
    expect(held.booking.status).toBe('held');
    const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
    const refused = await skill({
      skill: 'confirm_booking',
      booking_id: held.booking.booking_id,
      user_confirmed: false,
      customer,
      idempotency_key: crypto.randomUUID(),
    });
    expect(refused.error.code).toBe('user_confirmation_required');
    const done = await skill({
      skill: 'confirm_booking',
      booking_id: held.booking.booking_id,
      user_confirmed: true,
      customer,
      idempotency_key: crypto.randomUUID(),
    });
    expect(done.booking.status).toBe('confirmed');
  });

  it('replays the same hold for the same idempotency key', async () => {
    const found = await skill({ skill: 'search_availability', date: '2026-10-10', party_size: 2 });
    const args = {
      skill: 'hold_slot',
      slot_id: found.slots[0].slot_id,
      idempotency_key: crypto.randomUUID(),
    };
    const a = await skill(args);
    const b = await skill(args);
    expect(b.booking.booking_id).toBe(a.booking.booking_id);
  });

  it('explains usage when no skill is given', async () => {
    const data = await skill({ hello: 'there' });
    expect(data.error.suggested_next_action).toContain('search_availability');
  });

  it('answers protocol errors', async () => {
    expect((await call('GetTask', { id: 'x' })).error.code).toBe(-32001);
    expect((await call('Nope', {})).error.code).toBe(-32601);
    expect((await call('SendMessage', {})).error.code).toBe(-32602);
    const bad = await a2a.fetch(new Request('http://x/a2a', { method: 'POST', body: '{' }));
    expect(bad.status).toBe(400);
  });
});
