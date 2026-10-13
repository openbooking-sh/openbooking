import { describe, expect, it } from 'vitest';
import type { Booking } from '@openbooking-sh/core';
import { StripeError, StripePayments } from '../src';

const booking = { booking_id: 'bk_123' } as Booking;
const NOK = (amount: number) => ({ amount, currency: 'NOK' });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** A fake Stripe: records calls and answers with the next prepared response. */
function stripe(...responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: new URLSearchParams(String(init.body ?? '')),
    });
    const r = responses.shift() ?? { json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const make = (fetch: typeof globalThis.fetch, extra = {}) =>
  new StripePayments({
    secretKey: 'sk_test_abc',
    successUrl: (b) => `https://shop.example/thanks?booking=${b.booking_id}`,
    cancelUrl: 'https://shop.example/book',
    fetch,
    ...extra,
  });

describe('StripePayments', () => {
  it('creates a Checkout Session for the deposit and returns its page and id', async () => {
    const s = stripe({ json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' } });
    const out = await make(s.fetch).createCheckout({
      booking,
      amount: NOK(30000),
      description: 'Deposit: Color & cut',
      idempotency_key: 'checkout:bk_123',
    });
    expect(out).toEqual({ url: 'https://checkout.stripe.com/c/cs_test_1', token: 'cs_test_1' });

    const [call] = s.calls;
    expect(call!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call!.headers.authorization).toBe('Bearer sk_test_abc');
    expect(call!.headers['idempotency-key']).toBe('checkout:bk_123');
    expect(Object.fromEntries(call!.body)).toMatchObject({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'nok',
      'line_items[0][price_data][unit_amount]': '30000',
      'line_items[0][price_data][product_data][name]': 'Deposit: Color & cut',
      'metadata[booking_id]': 'bk_123',
      'payment_intent_data[metadata][booking_id]': 'bk_123',
      success_url: 'https://shop.example/thanks?booking=bk_123',
      cancel_url: 'https://shop.example/book',
    });
  });

  it('says a session is paid only when Stripe says so, and reports amount, booking and payment', async () => {
    const paid = {
      payment_status: 'paid',
      amount_total: 30000,
      currency: 'nok',
      metadata: { booking_id: 'bk_123' },
      payment_intent: { id: 'pi_9' },
    };
    const s = stripe({ json: paid }, { json: { ...paid, payment_status: 'unpaid' } });
    const p = make(s.fetch);
    expect(await p.verify('cs_test_1')).toEqual({
      paid: true,
      amount: NOK(30000),
      booking_id: 'bk_123',
      reference: 'pi_9',
    });
    expect((await p.verify('cs_test_2')).paid).toBe(false);
    expect(s.calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.stripe.com/v1/checkout/sessions/cs_test_1?expand[]=payment_intent',
    });
  });

  it('never calls Stripe for a token that is not a Checkout Session id', async () => {
    const s = stripe();
    const p = make(s.fetch);
    for (const token of ['tok_visa', '../refunds', 'cs_x/../../v1/customers', '']) {
      expect((await p.verify(token)).paid).toBe(false);
    }
    expect(s.calls).toEqual([]);
  });

  it('refunds the payment with an idempotency key, so a retry cannot refund twice', async () => {
    const s = stripe({ json: { id: 're_1' } });
    await make(s.fetch).refund({
      reference: 'pi_9',
      amount: NOK(30000),
      idempotency_key: 'refund:bk_123',
    });
    expect(s.calls[0]!.url).toBe('https://api.stripe.com/v1/refunds');
    expect(s.calls[0]!.headers['idempotency-key']).toBe('refund:bk_123');
    expect(Object.fromEntries(s.calls[0]!.body)).toEqual({
      payment_intent: 'pi_9',
      amount: '30000',
    });
  });

  it('surfaces Stripe errors, and works for a connected account', async () => {
    const s = stripe({ status: 402, json: { error: { message: 'Charge already refunded.' } } });
    const p = make(s.fetch, { stripeAccount: 'acct_42' });
    const err = await p
      .refund({ reference: 'pi_9', amount: NOK(1), idempotency_key: 'k' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({ status: 402, message: 'Charge already refunded.' });
    expect(s.calls[0]!.headers['stripe-account']).toBe('acct_42');
  });

  it('refuses something that is not a secret key', () => {
    expect(
      () => new StripePayments({ secretKey: 'pk_live_nope', successUrl: 'x', cancelUrl: 'y' }),
    ).toThrow(/secret key/);
  });
});
