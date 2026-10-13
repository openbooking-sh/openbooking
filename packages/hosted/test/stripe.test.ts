/**
 * Deposits through the owner's own Stripe account, end to end on hosted: connect the key, set a
 * deposit, book through the booking page's API, pay, get refunded on cancellation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@openbooking-sh/core';
import { createHostedApp } from '../src';

const BASE = 'http://localhost:3000';
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';
const KEY = 'sk_test_hosted_1234';
const ADA = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Stripe that remembers sessions; `pay` is the customer paying. */
function fakeStripe() {
  const calls: Array<{ method: string; url: string; auth: string; body: URLSearchParams }> = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const body = new URLSearchParams(String(init.body ?? ''));
    const auth = String((init.headers as Record<string, string>).authorization);
    calls.push({ method: String(init.method), url: u.pathname, auth, body });
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
    return json({ error: { message: 'unexpected' } }, 404);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    sessions,
    pay: (id: string) => (sessions.get(id)!.payment_status = 'paid'),
  };
}

function setup() {
  const stripe = fakeStripe();
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
  return { stripe, req };
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
