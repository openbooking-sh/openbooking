/**
 * Deposits through the owner's own Stripe account, end to end on hosted: connect the key, set a
 * deposit, book through the booking page's API, pay, get refunded on cancellation.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@openbooking-sh/core';
import { createHostedApp, starterSettings, venueConfig } from '../src';

const BASE = 'http://localhost:3000';
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';
const KEY = 'sk_test_hosted_1234';
const WHSEC = 'whsec_test_secret';
const ADA = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Stripe that remembers sessions; `pay` is the customer paying. */
function fakeStripe(options: { webhooks?: boolean } = {}) {
  const calls: Array<{
    method: string;
    url: string;
    auth: string;
    body: URLSearchParams;
    idempotency?: string;
  }> = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = new URLSearchParams(String(init.body ?? ''));
    const auth = String((init.headers as Record<string, string>).authorization);
    const idempotency = (init.headers as Record<string, string>)['idempotency-key'];
    calls.push({
      method: String(init.method),
      url: u.pathname,
      auth,
      body,
      ...(idempotency ? { idempotency } : {}),
    });
    const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
    if (auth !== `Bearer ${KEY}`) {
      return json({ error: { message: 'Invalid API Key provided.' } }, 401);
    }
    if (u.pathname === '/v1/checkout/sessions' && init.method === 'GET') return json({ data: [] });
    if (u.pathname === '/v1/checkout/sessions') {
      const id = `cs_test_${sessions.size + 1}`;
      sessions.set(id, {
        id,
        payment_status: 'unpaid',
        amount_total: Number(body.get('line_items[0][price_data][unit_amount]')),
        currency: body.get('line_items[0][price_data][currency]'),
        metadata: { booking_id: body.get('metadata[booking_id]') },
        payment_intent: { id: `pi_${id}` },
        success_url: body.get('success_url'),
        url: `https://checkout.stripe.com/c/${id}`,
      });
      return json(sessions.get(id));
    }
    if (u.pathname.startsWith('/v1/checkout/sessions/')) {
      const found = sessions.get(u.pathname.split('/').pop()!);
      return found ? json(found) : json({ error: { message: 'No such session' } }, 404);
    }
    if (u.pathname === '/v1/refunds') return json({ id: 're_1' });
    if (u.pathname === '/v1/webhook_endpoints' && init.method === 'POST') {
      return options.webhooks === false
        ? json({ error: { message: 'This key cannot write webhook endpoints.' } }, 403)
        : json({ id: 'we_1', secret: WHSEC });
    }
    if (u.pathname.startsWith('/v1/webhook_endpoints/')) return json({ deleted: true });
    return json({ error: { message: 'unexpected' } }, 404);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    sessions,
    pay: (id: string) => (sessions.get(id)!.payment_status = 'paid'),
  };
}

function setup(stripeOptions: { webhooks?: boolean } = {}) {
  const stripe = fakeStripe(stripeOptions);
  const clock = new ManualClock(NOW);
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock,
    stripeFetch: stripe.fetch,
  });
  cleanups.push(hosted.close);
  const req = async (
    path: string,
    opts: { method?: string; body?: unknown; token?: string } = {},
  ) => {
    const res = await hosted.app.request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  /** Deliver a Stripe webhook the way Stripe would, signed with the endpoint secret. */
  const webhook = async (event: unknown, over: { secret?: string; at?: number } = {}) => {
    const payload = JSON.stringify(event);
    const t = Math.floor((over.at ?? clock.now().getTime()) / 1000);
    const v1 = createHmac('sha256', over.secret ?? WHSEC)
      .update(`${t}.${payload}`)
      .digest('hex');
    const res = await hosted.app.request(`${BASE}/b/studio-nord/stripe/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': `t=${t},v1=${v1}` },
      body: payload,
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { stripe, req, clock, webhook };
}
type Req = ReturnType<typeof setup>['req'];

const signup = async (req: Req) =>
  (
    await req('/api/signup', {
      body: {
        business_name: 'Studio Nord',
        your_name: 'Maria Berg',
        email: 'owner@example.com',
        password: 'correct horse',
        category: 'hair_salon',
        city: 'Oslo',
      },
    })
  ).json.token as string;

async function ownerWithDeposit(req: Req, percent = 50) {
  const token = await signup(req);
  const connect = await req('/studio/api/integrations/stripe/connect', {
    body: { secret_key: KEY },
    token,
  });
  expect(connect.status, connect.text).toBe(200);
  const { settings } = (await req('/studio/api/settings', { token })).json;
  settings.payments = { deposit_percent: percent };
  const saved = await req('/studio/api/settings', { method: 'PUT', body: settings, token });
  expect(saved.status, saved.text).toBe(200);
  return token;
}

const page = '/b/studio-nord/book';

async function hold(req: Req, service = 'color-cut') {
  const slots = await req(`${page}/api/availability?date=${DAY}&service=${service}`);
  const h = await req(`${page}/api/hold`, {
    body: { slot_id: slots.json.slots[0].slot_id, idempotency_key: `hold-${service}` },
  });
  expect(h.status, h.text).toBe(200);
  return h.json.booking as { booking_id: string; deposit: { amount: { amount: number } } | null };
}

describe('deposits on hosted', () => {
  it('checks the key with Stripe, never shows it again, and refuses a bad one', async () => {
    const { req, stripe } = setup();
    const token = await signup(req);
    const connect = (secret_key: string) =>
      req('/studio/api/integrations/stripe/connect', { body: { secret_key }, token });

    const bad = await connect('sk_test_wrong');
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('Invalid API Key');
    expect((await connect('pk_live_nope')).status).toBe(400);

    expect((await connect(KEY)).status).toBe(200);
    const view = await req('/studio/api/settings', { token });
    expect(view.json.integrations.stripe).toMatchObject({
      connected: true,
      mode: 'test',
      key_hint: '1234',
    });
    expect(view.text).not.toContain(KEY);
    expect((await req('/studio/api/account/export', { token })).text).not.toContain(KEY);
    expect(stripe.calls.some((c) => c.url === '/v1/checkout/sessions')).toBe(true);
  });

  it('takes a deposit on the booking page, then refunds it on cancellation', async () => {
    const { req, stripe } = setup();
    await ownerWithDeposit(req);
    const held = await hold(req);
    // 50% of 1450 NOK.
    expect(held.deposit!.amount.amount).toBe(72500);

    const confirm = (extra: Record<string, unknown> = {}) =>
      req(`${page}/api/confirm`, {
        body: {
          booking_id: held.booking_id,
          idempotency_key: 'confirm-1',
          customer: ADA,
          user_confirmed: true,
          ...extra,
        },
      });

    const asked = await confirm();
    expect(asked.json.error.code).toBe('payment_required');
    const { payment_url, payment_token } = asked.json.error.details;
    expect(payment_url).toBe(`https://checkout.stripe.com/c/${payment_token}`);
    expect(stripe.sessions.get(payment_token)!.success_url).toBe(
      `${BASE}/b/studio-nord?paid=${held.booking_id}&session_id={CHECKOUT_SESSION_ID}`,
    );

    // Not paid yet, and a made-up token: neither confirms.
    expect((await confirm({ payment_token })).json.error.code).toBe('payment_failed');
    expect((await confirm({ payment_token: 'tok_visa' })).json.error.code).toBe('payment_failed');

    stripe.pay(payment_token);
    const done = await confirm({ payment_token });
    expect(done.status, done.text).toBe(200);
    expect(done.json.booking.status).toBe('confirmed');

    const cancelled = await req(`${page}/api/bookings/${held.booking_id}/cancel`, {
      body: {
        code: done.json.booking.confirmation_code,
        idempotency_key: 'cancel-1',
        user_confirmed: true,
      },
    });
    expect(cancelled.status, cancelled.text).toBe(200);
    const refund = stripe.calls.find((c) => c.url === '/v1/refunds')!;
    expect(Object.fromEntries(refund.body)).toEqual({
      payment_intent: `pi_${payment_token}`,
      amount: '72500',
    });
  });

  it('offers no deposit without a percentage, and none after Stripe is disconnected', async () => {
    const { req } = setup();
    const token = await ownerWithDeposit(req, 0);
    expect((await hold(req)).deposit).toBeNull();

    const { settings } = (await req('/studio/api/settings', { token })).json;
    settings.payments = { deposit_percent: 30 };
    await req('/studio/api/settings', { method: 'PUT', body: settings, token });
    expect((await hold(req, 'haircut')).deposit?.amount.amount).toBe(19500);

    await req('/studio/api/integrations/stripe/disconnect', { body: {}, token });
    expect((await hold(req, 'blow-dry')).deposit).toBeNull();
  });
});

const paidEvent = (session: string, booking: string) => ({
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: {
    object: { id: session, payment_status: 'paid', metadata: { booking_id: booking } },
  },
});

describe('Stripe webhooks', () => {
  it('registers a webhook when the key is connected, and says so when it cannot', async () => {
    const ok = setup();
    const token = await signup(ok.req);
    await ok.req('/studio/api/integrations/stripe/connect', { body: { secret_key: KEY }, token });
    const hook = ok.stripe.calls.find((c) => c.url === '/v1/webhook_endpoints')!;
    expect(hook.body.get('url')).toBe(`${BASE}/b/studio-nord/stripe/webhook`);
    const view = await ok.req('/studio/api/settings', { token });
    expect(view.json.integrations.stripe.webhook).toBe(true);
    expect(view.text).not.toContain(WHSEC);
    await ok.req('/studio/api/integrations/stripe/disconnect', { body: {}, token });
    expect(ok.stripe.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/we_1'))).toBe(
      true,
    );

    const limited = setup({ webhooks: false });
    const t2 = await signup(limited.req);
    const connected = await limited.req('/studio/api/integrations/stripe/connect', {
      body: { secret_key: KEY },
      token: t2,
    });
    expect(connected.status).toBe(200);
    const view2 = await limited.req('/studio/api/settings', { token: t2 });
    expect(view2.json.integrations.stripe.webhook).toBe(false);
  });

  it('refunds a customer who paid after the hold ran out and never came back', async () => {
    const { req, stripe, clock, webhook } = setup();
    await ownerWithDeposit(req);
    const held = await hold(req);
    const asked = await req(`${page}/api/confirm`, {
      body: {
        booking_id: held.booking_id,
        idempotency_key: 'confirm-c1',
        customer: ADA,
        user_confirmed: true,
      },
    });
    const session = asked.json.error.details.payment_token as string;
    stripe.pay(session);

    // The customer may still be on their way back: ask Stripe to try again later.
    expect((await webhook(paidEvent(session, held.booking_id))).status).toBe(503);
    expect(stripe.calls.some((c) => c.url === '/v1/refunds')).toBe(false);

    clock.set(new Date(clock.now().getTime() + 11 * 60_000).toISOString());
    const first = await webhook(paidEvent(session, held.booking_id));
    expect(first).toMatchObject({ status: 200, json: { result: 'refunded' } });
    // Stripe delivers events more than once: the same refund key, so no second refund.
    await webhook(paidEvent(session, held.booking_id));
    const refunds = stripe.calls.filter((c) => c.url === '/v1/refunds');
    expect(refunds.length).toBeGreaterThan(0);
    expect(new Set(refunds.map((r) => r.idempotency))).toEqual(
      new Set([`refund:${held.booking_id}`]),
    );
    expect(Object.fromEntries(refunds[0]!.body)).toEqual({
      payment_intent: `pi_${session}`,
      amount: '72500',
    });
  });

  it('leaves a booking the customer already confirmed alone', async () => {
    const { req, stripe, webhook } = setup();
    await ownerWithDeposit(req);
    const held = await hold(req);
    const asked = await req(`${page}/api/confirm`, {
      body: {
        booking_id: held.booking_id,
        idempotency_key: 'confirm-c1',
        customer: ADA,
        user_confirmed: true,
      },
    });
    const session = asked.json.error.details.payment_token as string;
    stripe.pay(session);
    const done = await req(`${page}/api/confirm`, {
      body: {
        booking_id: held.booking_id,
        idempotency_key: 'confirm-c1',
        customer: ADA,
        user_confirmed: true,
        payment_token: session,
      },
    });
    expect(done.json.booking.status).toBe('confirmed');
    expect(await webhook(paidEvent(session, held.booking_id))).toMatchObject({
      status: 200,
      json: { result: 'settled' },
    });
    expect(stripe.calls.some((c) => c.url === '/v1/refunds')).toBe(false);
  });

  it('refuses what is not signed by Stripe or is old, and ignores what is not ours', async () => {
    const { req, webhook, clock } = setup();
    await ownerWithDeposit(req);
    const event = paidEvent('cs_test_1', 'bk_x');
    expect((await webhook(event, { secret: 'whsec_forged' })).status).toBe(400);
    expect((await webhook(event, { at: clock.now().getTime() - 3_600_000 })).status).toBe(400);
    // Signed, but not a payment of ours: acknowledged and ignored.
    expect((await webhook({ ...event, type: 'customer.created' })).status).toBe(200);
    const noBooking = { ...event, data: { object: { id: 'cs_1', payment_status: 'paid' } } };
    expect((await webhook(noBooking)).json).toMatchObject({ ignored: true });
    expect((await webhook(event)).json).toMatchObject({ ignored: true });
  });
});

describe('businesses saved before online payments existed', () => {
  it('still build a catalog, without a deposit', () => {
    const settings: any = starterSettings({
      name: 'Old Salon',
      ownerName: 'Ola',
      category: 'barber',
    });
    delete settings.payments;
    const now = new Date().toISOString();
    const venue = venueConfig({
      id: 'old-salon',
      owner: { email: 'o@example.com', password_hash: 'x' },
      settings,
      stripe: { secret_key: KEY },
      created_at: now,
      updated_at: now,
      version: 1,
    });
    expect(venue.offerings.every((o) => !o.deposit)).toBe(true);
  });
});
