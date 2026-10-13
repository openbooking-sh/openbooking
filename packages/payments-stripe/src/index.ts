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
    method: 'GET' | 'POST',
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
