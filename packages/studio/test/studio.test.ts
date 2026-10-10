import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, runAsActor } from '@openbooking-sh/core';
import { createDemoRestaurantProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import { actorFromRequest, agentName, createStudio } from '../src';

function setup(opts: { token?: string; insecureNoAuth?: boolean } = { token: 'secret-token' }) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({ provider: createDemoRestaurantProvider(), clock });
  const studio = createStudio({ service, ...opts });
  const app = new Hono().route('/studio', studio.app);
  const get = async (path: string, token?: string) => {
    const res = await app.request(`/studio${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { service, studio, app, get, clock };
}

async function bookAs(service: BookingService, agent: string, n = 1) {
  return runAsActor({ protocol: 'mcp', agent }, async () => {
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 2 },
      offering_id: 'dinner',
    });
    const hold = await service.hold({
      slot_id: slots[n]!.slot_id,
      idempotency_key: `hold-${agent}-${n}`,
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
    });
    return service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: `confirm-${agent}-${n}`,
      user_confirmed: true,
    });
  });
}

describe('Studio auth', () => {
  it('serves the UI shell without auth but locks the API', async () => {
    const { app, get } = setup();
    const page = await app.request('/studio');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('OpenBooking Studio');
    expect((await get('/api/session')).status).toBe(401);
    expect((await get('/api/session', 'wrong-token-xx')).status).toBe(401);
    expect((await get('/api/session', 'secret-token')).status).toBe(200);
  });

  it('is locked when no token is configured and insecureNoAuth is not set', async () => {
    const { get } = setup({});
    const res = await get('/api/session');
    expect(res.status).toBe(401);
    expect(res.json.error.message).toContain('STUDIO_TOKEN');
  });

  it('allows access without token only with explicit insecureNoAuth', async () => {
    const { get } = setup({ insecureNoAuth: true });
    expect((await get('/api/session')).status).toBe(200);
  });
});

describe('Studio data', () => {
  it('attributes bookings and activity to the agent that made them', async () => {
    const { service, get } = setup();
    await bookAs(service, 'Claude', 0);
    await bookAs(service, 'Claude', 1);
    await bookAs(service, 'ChatGPT', 2);

    const overview = (await get('/api/overview', 'secret-token')).json;
    expect(overview.kpis).toMatchObject({ upcoming_confirmed: 3, hold_to_booking_rate: 1 });
    expect(overview.agents.map((a: any) => [a.agent, a.bookings])).toEqual([
      ['Claude', 2],
      ['ChatGPT', 1],
    ]);

    const { bookings } = (await get('/api/bookings?status=confirmed', 'secret-token')).json;
    expect(bookings).toHaveLength(3);
    expect(bookings.map((b: any) => b.booked_via).sort()).toEqual(['ChatGPT', 'Claude', 'Claude']);

    const detail = (await get(`/api/bookings/${bookings[0].booking_id}`, 'secret-token')).json;
    expect(detail.activity.map((e: any) => e.operation)).toEqual(['confirm', 'hold']);
  });

  it('records failed agent calls with their error code', async () => {
    const { service, get } = setup();
    await runAsActor({ protocol: 'mcp', agent: 'Gemini' }, () =>
      service.confirm({
        booking_id: 'nope',
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
      }),
    ).catch(() => {});
    const { activity } = (await get('/api/activity', 'secret-token')).json;
    expect(activity[0]).toMatchObject({
      agent: 'Gemini',
      operation: 'confirm',
      ok: false,
      error_code: 'not_found',
      booking_id: 'nope',
    });
  });

  it('lets staff cancel a booking', async () => {
    const { service, app } = setup();
    const booking = await bookAs(service, 'Claude');
    const res = await app.request(`/studio/api/bookings/${booking.booking_id}/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(((await res.json()) as any).booking.status).toBe('cancelled');
  });

  it('shows availability exactly as agents see it', async () => {
    const { get } = setup();
    const res = (
      await get(
        '/api/availability?date=2026-10-02&party_size=2&time_from=19:00&time_to=19:00',
        'secret-token',
      )
    ).json;
    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots[0].cancellation_policy.description).toBeTruthy();
  });
});

describe('agent identification', () => {
  it('maps common clients to display names', () => {
    expect(agentName('claude-ai')).toBe('Claude');
    expect(agentName('Claude-User/1.0')).toBe('Claude');
    expect(agentName('openai-mcp')).toBe('ChatGPT');
    expect(agentName('ChatGPT-User/1.0; +https://openai.com/bot')).toBe('ChatGPT');
    expect(agentName('mcp-inspector')).toBe('MCP Inspector');
    expect(agentName('curl/8.4.0')).toBe('curl');
    expect(agentName(undefined)).toBe('Unknown agent');
  });

  it('reads MCP clientInfo from _meta (2026 era) and initialize (2025 era)', async () => {
    const req = (body: unknown, ua?: string) =>
      new Request('http://x/mcp', {
        method: 'POST',
        headers: ua ? { 'user-agent': ua } : {},
        body: JSON.stringify(body),
      });
    const modern = await actorFromRequest(
      req({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai' } } },
      }),
      'mcp',
    );
    expect(modern).toMatchObject({ agent: 'Claude', client: 'claude-ai', protocol: 'mcp' });

    const init = await actorFromRequest(
      req({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'openai-mcp' } },
      }),
      'mcp',
    );
    expect(init.agent).toBe('ChatGPT');

    const legacyCall = await actorFromRequest(
      req({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }, 'Claude-User'),
      'mcp',
    );
    expect(legacyCall.agent).toBe('Claude');
  });

  it('reads the UCP-Agent profile host', async () => {
    const actor = await actorFromRequest(
      new Request('http://x/ucp/booking-sessions', {
        headers: { 'ucp-agent': 'profile="https://agents.perplexity.ai/.well-known/ucp"' },
      }),
      'ucp',
    );
    expect(actor.agent).toBe('Perplexity');
  });
});

describe('Studio as a booking system (salon)', () => {
  async function salon() {
    const { createDemoSalonProvider } = await import('@openbooking-sh/provider-memory');
    const clock = new ManualClock('2026-10-01T06:00:00Z');
    const service = new BookingService({ provider: createDemoSalonProvider(), clock });
    const studio = createStudio({ service, token: 'secret-token' });
    const app = new Hono().route('/studio', studio.app);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/studio${path}`, {
        method,
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    return { service, call };
  }

  it('lists services and staff', async () => {
    const { call } = await salon();
    const { json } = await call('GET', '/api/catalog');
    expect(json.offerings.map((o: any) => o.name)).toEqual([
      'Haircut',
      'Beard trim',
      'Color & cut',
    ]);
    expect(json.resources.map((r: any) => r.name)).toEqual(['Maria', 'Jonas', 'Aisha']);
  });

  it('creates staff bookings and shows them on the calendar per stylist', async () => {
    const { call } = await salon();
    const avail = (
      await call(
        'GET',
        '/api/availability?date=2026-10-02&party_size=1&offering_id=haircut&time_from=15:00&time_to=15:00',
      )
    ).json;
    const created = await call('POST', '/api/bookings', {
      slot_id: avail.slots[0].slot_id,
      customer: { first_name: 'Ola', last_name: 'Nordmann', phone_number: '+4791234567' },
      notes: 'Called in',
    });
    expect(created.status).toBe(200);
    expect(created.json.booking).toMatchObject({ status: 'confirmed', booked_via: 'Studio' });

    const cal = (await call('GET', '/api/calendar?date=2026-10-02')).json;
    expect(cal.timezone).toBe('Europe/Oslo');
    expect(cal.resources.map((r: any) => r.id)).toEqual(['maria', 'jonas', 'aisha']);
    expect(cal.bookings).toHaveLength(1);
    expect(cal.bookings[0].slot.resource).toMatchObject({ id: 'maria', label: 'Maria' });
    expect((await call('GET', '/api/calendar?date=2026-10-03')).json.bookings).toEqual([]);
  });

  it('requires the deposit to be collected for staff bookings of deposit services', async () => {
    const { call } = await salon();
    const avail = (
      await call(
        'GET',
        '/api/availability?date=2026-10-02&party_size=1&offering_id=color-cut&time_from=10:00&time_to=10:00',
      )
    ).json;
    const customer = { first_name: 'Kari', last_name: 'Nordmann', phone_number: '+4799999999' };
    const refused = await call('POST', '/api/bookings', {
      slot_id: avail.slots[0].slot_id,
      customer,
    });
    expect(refused.json.error.code).toBe('payment_required');
    // The refused attempt released its hold, so the same slot can be booked once collected.
    const ok = await call('POST', '/api/bookings', {
      slot_id: avail.slots[0].slot_id,
      customer,
      deposit_collected: true,
    });
    expect(ok.json.booking.payment).toMatchObject({
      status: 'paid',
      reference: 'manual:collected-in-studio',
    });
  });

  it('aggregates customers across bookings', async () => {
    const { service, call } = await salon();
    const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
    for (const [i, time] of ['10:00', '15:00'].entries()) {
      const { slots } = await service.searchAvailability({
        date: '2026-10-02',
        party_size: { total: 1 },
        offering_id: 'haircut',
        time_from: time,
        time_to: time,
      });
      await runAsActor({ protocol: 'mcp', agent: 'Claude' }, async () => {
        const h = await service.hold({
          slot_id: slots[0]!.slot_id,
          idempotency_key: `cust-hold-${i}`,
          customer,
        });
        await service.confirm({
          booking_id: h.booking_id,
          idempotency_key: `cust-confirm-${i}`,
          user_confirmed: true,
        });
      });
    }
    const { customers } = (await call('GET', '/api/customers')).json;
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      name: 'Ada Lovelace',
      bookings: 2,
      spend: 130000,
      currency: 'NOK',
      first_source: 'Claude',
    });
    expect(customers[0].next_visit).toBe('2026-10-02T10:00:00+02:00');
  });
});

describe('booking channels', () => {
  it('counts staff bookings made in Studio as a channel', async () => {
    const { createDemoSalonProvider } = await import('@openbooking-sh/provider-memory');
    const service = new BookingService({
      provider: createDemoSalonProvider(),
      clock: new ManualClock('2026-10-01T06:00:00Z'),
    });
    const studio = createStudio({ service, token: 'secret-token' });
    const app = new Hono().route('/studio', studio.app);
    const auth = { authorization: 'Bearer secret-token', 'content-type': 'application/json' };
    const avail = (await (
      await app.request(
        '/studio/api/availability?date=2026-10-02&party_size=1&offering_id=haircut',
        { headers: auth },
      )
    ).json()) as any;
    await app.request('/studio/api/bookings', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        slot_id: avail.slots[0].slot_id,
        customer: { first_name: 'Ola', last_name: 'N', phone_number: '+4791234567' },
      }),
    });
    const overview = (await (
      await app.request('/studio/api/overview', { headers: auth })
    ).json()) as any;
    expect(overview.agents).toEqual([expect.objectContaining({ agent: 'Studio', bookings: 1 })]);
  });
});

describe('Studio customer data', () => {
  const post = (app: Hono, path: string, body: unknown, token?: string) =>
    app.request(`/studio${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it('offers nothing unless the host supplies it', async () => {
    const { app, get } = setup();
    expect((await get('/api/session', 'secret-token')).json.data_rights).toBe(false);
    expect(
      (await post(app, '/api/customers/erase', { email: 'a@b.co' }, 'secret-token')).status,
    ).toBe(404);
  });

  it('hands the customer to the host, behind the token, and refuses a request about nobody', async () => {
    const seen: unknown[] = [];
    const service = new BookingService({ provider: createDemoRestaurantProvider() });
    const studio = createStudio({
      service,
      token: 'secret-token',
      dataRights: {
        exportCustomer: async (who) => (seen.push(['export', who]), []),
        eraseCustomer: async (who) => (
          seen.push(['erase', who]),
          { anonymized: 2, kept_upcoming: 1 }
        ),
      },
    });
    const app = new Hono().route('/studio', studio.app);

    expect((await post(app, '/api/customers/erase', { email: 'a@b.co' })).status).toBe(401);
    expect((await post(app, '/api/customers/erase', {}, 'secret-token')).status).toBe(400);
    const erased = await post(app, '/api/customers/erase', { email: 'a@b.co' }, 'secret-token');
    expect(await erased.json()).toEqual({ anonymized: 2, kept_upcoming: 1 });
    const exported = await post(
      app,
      '/api/customers/export',
      { phone: '+4712345678' },
      'secret-token',
    );
    expect(((await exported.json()) as any).bookings).toEqual([]);
    expect(seen).toEqual([
      ['erase', { email: 'a@b.co' }],
      ['export', { phone: '+4712345678' }],
    ]);
  });
});
