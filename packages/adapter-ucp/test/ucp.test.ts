import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking/core';
import { createDemoRestaurantProvider } from '@openbooking/provider-memory';
import { Hono } from 'hono';
import { buildUcpProfile, createUcpRouter, UCP_VERSION } from '../src';

function setup() {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({
    provider: createDemoRestaurantProvider(),
    clock,
    holdTtlSeconds: 300,
  });
  const app = new Hono().route(
    '/ucp',
    createUcpRouter({ service, baseUrl: 'https://bistro.example' }),
  );
  const req = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(`/ucp${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const write = (method: string, path: string, body: unknown, key = randomUUID()) =>
    req(method, path, body, { 'Idempotency-Key': key });
  return { req, write, clock };
}

const BOOKER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

describe('UCP discovery profile', () => {
  it('follows the business profile shape', () => {
    const p = buildUcpProfile({ baseUrl: 'https://bistro.example/' });
    expect(p.ucp.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.ucp.payment_handlers).toEqual({});
    expect(p.ucp.services['dev.ucp.lodging']![0]).toMatchObject({
      transport: 'rest',
      endpoint: 'https://bistro.example/ucp',
    });
    for (const entries of Object.values(p.ucp.capabilities)) {
      for (const e of entries) expect(e.schema).toMatch(/^https:\/\//);
    }
    expect(p.ucp.capabilities['sh.openbooking.booking']![0]!.extends).toEqual([
      'dev.ucp.lodging.booking',
    ]);
  });
});

describe('UCP booking sessions', () => {
  it('runs availability → create → update → complete → cancel', async () => {
    const { req, write } = setup();
    const avail = await req(
      'GET',
      '/availability?date=2026-10-02&party_size=2&time_from=19:00&offering_id=dinner',
    );
    expect(avail.status).toBe(200);
    const offer = avail.json.offers[0];
    expect(offer).toMatchObject({
      stay_dates: { start_date: '2026-10-02', end_date: '2026-10-02' },
      time_slot: { start_at: '2026-10-02T19:00:00+02:00', timezone: 'Europe/Oslo' },
      rate_plan: { id: 'dinner', title: 'Dinner' },
      occupancy: { total: 2 },
      currency: 'NOK',
    });

    const created = await write('POST', '/booking-sessions', {
      property: { id: 'demo-bistro' },
      stays: [{ id: offer.id }],
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ status: 'incomplete', currency: 'NOK', links: [] });
    expect(created.json.ucp.version).toBe(UCP_VERSION);
    expect(created.json.expires_at).toBeTruthy();
    expect(created.json.totals.map((t: any) => t.type)).toEqual(['subtotal', 'total']);
    expect(created.json.policies[0]).toMatchObject({
      type: 'dev.ucp.lodging.policy.cancellation',
      refundability: 'refundable',
    });
    expect(created.json.messages[0]).toMatchObject({
      code: 'customer_details_required',
      path: '$.booker',
    });
    const id = created.json.id;

    const updated = await write('PUT', `/booking-sessions/${id}`, {
      booker: BOOKER,
      stays: [{ id: offer.id }],
    });
    expect(updated.json.status).toBe('ready_for_complete');
    expect(updated.json.booker).toEqual(BOOKER);

    const noConsent = await write('POST', `/booking-sessions/${id}/complete`, { payment: {} });
    expect(noConsent.status).toBe(200);
    expect(noConsent.json.status).toBe('ready_for_complete');
    expect(noConsent.json.messages[0]).toMatchObject({
      type: 'error',
      code: 'user_confirmation_required',
      severity: 'recoverable',
    });

    const done = await write('POST', `/booking-sessions/${id}/complete`, {
      payment: {},
      user_confirmed: true,
    });
    expect(done.json.status).toBe('completed');
    expect(done.json.confirmation.id).toBeTruthy();
    expect(done.json.expires_at).toBeUndefined();

    const cancelled = await write('POST', `/booking-sessions/${id}/cancel`, {
      user_confirmed: true,
    });
    expect(cancelled.json.status).toBe('canceled');
  });

  it('requires Idempotency-Key and replays identical requests', async () => {
    const { req, write } = setup();
    const offer = (
      await req(
        'GET',
        '/availability?date=2026-10-02&party_size=8&time_from=19:00&time_to=19:00&offering_id=dinner',
      )
    ).json.offers[0];
    const missing = await req('POST', '/booking-sessions', { stays: [{ id: offer.id }] });
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({
      ucp: { status: 'error' },
      messages: [{ type: 'error', code: 'validation_error' }],
    });

    const key = randomUUID();
    const a = await write('POST', '/booking-sessions', { stays: [{ id: offer.id }] }, key);
    const b = await write('POST', '/booking-sessions', { stays: [{ id: offer.id }] }, key);
    expect(b.json.id).toBe(a.json.id);

    const conflict = await write(
      'POST',
      '/booking-sessions',
      { stays: [{ id: offer.id }], booker: BOOKER },
      key,
    );
    expect(conflict.status).toBe(409);
  });

  it('maps sold-out to inventory_exhausted', async () => {
    const { req, write } = setup();
    const offer = (
      await req(
        'GET',
        '/availability?date=2026-10-02&party_size=8&time_from=19:00&time_to=19:00&offering_id=dinner',
      )
    ).json.offers[0];
    await write('POST', '/booking-sessions', { stays: [{ id: offer.id }] });
    const second = await write('POST', '/booking-sessions', { stays: [{ id: offer.id }] });
    expect(second.json).toMatchObject({
      ucp: { status: 'error' },
      messages: [{ code: 'inventory_exhausted', severity: 'unrecoverable' }],
    });
    expect(second.json.messages[0].suggested_next_action).toBeTruthy();
  });

  it('reports expired holds as canceled', async () => {
    const { req, write, clock } = setup();
    const offer = (await req('GET', '/availability?date=2026-10-02&party_size=2')).json.offers[0];
    const created = await write('POST', '/booking-sessions', {
      stays: [{ id: offer.id }],
      booker: BOOKER,
    });
    clock.advanceSeconds(301);
    const res = await write('POST', `/booking-sessions/${created.json.id}/complete`, {
      user_confirmed: true,
    });
    expect(res.json.status).toBe('canceled');
    expect(res.json.messages[0]).toMatchObject({ code: 'hold_expired', severity: 'unrecoverable' });
  });

  it('serves extension schemas and returns 404 for unknown sessions', async () => {
    const { req } = setup();
    const schema = await req('GET', '/schemas/sh.openbooking.booking.json');
    expect(schema.json.$defs['dev.ucp.lodging.booking'].allOf).toHaveLength(2);
    expect((await req('GET', '/booking-sessions/nope')).status).toBe(404);
  });
});
