/**
 * Stripe deposits for OpenBooking, over Stripe's HTTP API with plain `fetch` (no SDK, so it runs
 * on Node, edge runtimes and Workers).
 *
 * The customer pays on a Stripe Checkout page. Nothing is trusted from the caller: the engine
 * hands the Checkout Session id back to {@link StripePayments.verify}, which asks Stripe whether
 * it was paid, for how much, and for which booking.
 *
 * ```ts
 * const service = new BookingService({
 *   provider,
 *   payments: new StripePayments({
 *     secretKey: process.env.STRIPE_SECRET_KEY!,
 *     successUrl: 'https://example.com/booked',
 *     cancelUrl: 'https://example.com/book',
 *   }),
 * });
 * ```
 */
import type {
  Booking,
  Checkout,
  CheckoutRequest,
  PaymentProvider,
  PaymentVerification,
  RefundRequest,
} from '@openbooking-sh/core';

export interface StripePaymentsOptions {
  /** `sk_live_…` or `sk_test_…`, or a restricted key that may write Checkout Sessions and Refunds. */
  secretKey: string;
  /** Where Stripe sends the customer after paying. */
  successUrl: string | ((booking: Booking) => string);
  /** Where Stripe sends the customer if they back out. */
  cancelUrl: string | ((booking: Booking) => string);
  /** A connected account (Stripe Connect): money goes to the business, not to you. */
  stripeAccount?: string;
  fetch?: typeof fetch;
  /** Default `https://api.stripe.com`. */
  baseUrl?: string;
}

/** A Stripe API call that came back with an error. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

export class StripePayments implements PaymentProvider {
  readonly #o: StripePaymentsOptions;
  readonly #fetch: typeof fetch;

  constructor(options: StripePaymentsOptions) {
    if (!/^(sk|rk)_(test|live)_/.test(options.secretKey)) {
      throw new Error('secretKey must be a Stripe secret key (sk_test_… or sk_live_…).');
    }
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async createCheckout(req: CheckoutRequest): Promise<Checkout> {
    const { booking } = req;
    const url = (v: string | ((b: Booking) => string)) => (typeof v === 'string' ? v : v(booking));
    const session = await this.#call('POST', '/v1/checkout/sessions', {
      body: form({
        mode: 'payment',
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': req.amount.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': req.amount.amount,
        'line_items[0][price_data][product_data][name]': req.description,
        client_reference_id: booking.booking_id,
        'metadata[booking_id]': booking.booking_id,
        'payment_intent_data[metadata][booking_id]': booking.booking_id,
        success_url: url(this.#o.successUrl),
        cancel_url: url(this.#o.cancelUrl),
      }),
      idempotencyKey: req.idempotency_key,
    });
    if (typeof session.id !== 'string' || typeof session.url !== 'string') {
      throw new StripeError(502, 'Stripe returned a Checkout Session without an id or url.');
    }
    return { url: session.url, token: session.id };
  }

  /** Is the key accepted, and may it read Checkout Sessions? Throws {@link StripeError} if not. */
  async check(): Promise<void> {
    await this.#call('GET', '/v1/checkout/sessions', { query: 'limit=1' });
  }

  /**
   * Ask Stripe to call `url` when a Checkout Session is paid. The signing secret is only returned
   * now, so keep it. Needs a key that may write Webhook Endpoints.
   */
  async createWebhook(url: string): Promise<{ id: string; secret: string }> {
    const hook = await this.#call('POST', '/v1/webhook_endpoints', {
      body: form({
        url,
        'enabled_events[0]': 'checkout.session.completed',
        'enabled_events[1]': 'checkout.session.async_payment_succeeded',
      }),
    });
    if (typeof hook.id !== 'string' || typeof hook.secret !== 'string') {
      throw new StripeError(502, 'Stripe returned a webhook endpoint without an id or secret.');
    }
    return { id: hook.id, secret: hook.secret };
  }

  async deleteWebhook(id: string): Promise<void> {
    if (!/^we_[A-Za-z0-9_]+$/.test(id)) return;
    await this.#call('DELETE', `/v1/webhook_endpoints/${id}`);
  }

  async verify(token: string): Promise<PaymentVerification> {
    // A real Checkout Session id only: it goes into a URL path.
    if (!/^cs_[A-Za-z0-9_]+$/.test(token)) {
      return {
        paid: false,
        amount: { amount: 0, currency: 'USD' },
        booking_id: null,
        reference: '',
      };
    }
    const session = await this.#call('GET', `/v1/checkout/sessions/${token}`, {
      query: 'expand[]=payment_intent',
    });
    const intent = session.payment_intent;
    const reference =
      typeof intent === 'string' ? intent : ((intent as { id?: string } | null)?.id ?? '');
    const metadata = (session.metadata ?? {}) as Record<string, string>;
    return {
      paid: session.payment_status === 'paid' && reference !== '',
      amount: {
        amount: Number(session.amount_total ?? 0),
        currency: String(session.currency ?? 'usd').toUpperCase(),
      },
      booking_id: metadata.booking_id ?? (session.client_reference_id as string | null) ?? null,
      reference,
    };
  }

  async refund(req: RefundRequest): Promise<void> {
    await this.#call('POST', '/v1/refunds', {
      body: form({ payment_intent: req.reference, amount: req.amount.amount }),
      idempotencyKey: req.idempotency_key,
    });
  }

  async #call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: string; query?: string; idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#fetch(
      `${this.#o.baseUrl ?? 'https://api.stripe.com'}${path}${opts.query ? `?${opts.query}` : ''}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.#o.secretKey}`,
          ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          // Stripe replays the first answer for a repeated key, so a retry never charges twice.
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
          ...(this.#o.stripeAccount ? { 'stripe-account': this.#o.stripeAccount } : {}),
        },
        ...(opts.body ? { body: opts.body } : {}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    } & Record<string, unknown>;
    if (!res.ok) throw new StripeError(res.status, json.error?.message ?? `HTTP ${res.status}`);
    return json;
  }
}

function form(fields: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(fields).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
}

/** What a Stripe webhook delivers: the parts we read. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Check a webhook really came from Stripe: the `Stripe-Signature` header carries a timestamp and
 * an HMAC-SHA256 of `<timestamp>.<raw body>` under the endpoint's signing secret. Pass the body
 * exactly as received. Throws when the signature is wrong or the timestamp is too old (replay).
 */
export async function verifyWebhook(
  payload: string,
  header: string | null | undefined,
  secret: string,
  options: { now?: () => number; toleranceSeconds?: number } = {},
): Promise<StripeEvent> {
  const parts = (header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new StripeError(400, 'Missing or malformed Stripe-Signature header.');
  }
  const age = Math.abs((options.now?.() ?? Date.now()) / 1000 - timestamp);
  if (age > (options.toleranceSeconds ?? 300)) {
    throw new StripeError(400, 'The webhook timestamp is too old.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = new TextEncoder().encode(`${timestamp}.${payload}`);
  for (const sig of signatures) {
    const bytes = hexToBytes(sig);
    // crypto.subtle.verify compares in constant time.
    if (bytes && (await crypto.subtle.verify('HMAC', key, bytes, data))) {
      try {
        return JSON.parse(payload) as StripeEvent;
      } catch {
        throw new StripeError(400, 'The webhook body is not JSON.');
      }
    }
  }
  throw new StripeError(400, 'The webhook signature does not match.');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
