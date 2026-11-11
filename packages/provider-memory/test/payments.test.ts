import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BookingService,
  ManualClock,
  runAsActor,
  type BookingError,
  type Checkout,
  type CheckoutRequest,
  type Money,
  type PaymentProvider,
  type PaymentVerification,
  type RefundRequest,
} from '@openbooking-sh/core';
import { MemoryBookingProvider, createDemoSalonProvider, demoSalonConfig } from '../src';

const NOW = '2026-10-01T06:00:00Z';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

/** A payment page that exists only in memory: `pay()` is the customer paying. */
class FakePayments implements PaymentProvider {
  sessions = new Map<string, PaymentVerification>();
  refunds: RefundRequest[] = [];
  failRefunds = 0;
  /** Runs once, while the engine is checking a payment: what happens in the meantime. */
  duringVerify: (() => Promise<void>) | undefined;

  async createCheckout(req: CheckoutRequest): Promise<Checkout> {
    const token = `cs_${req.idempotency_key}`;
    this.sessions.set(token, {
      paid: false,
      amount: req.amount,
      booking_id: req.booking.booking_id,
      reference: `pi_${req.booking.booking_id}`,
    });
    return { url: `https://pay.example/${token}`, token };
  }
  pay(token: string, over: Partial<PaymentVerification> = {}) {
    this.sessions.set(token, { ...this.sessions.get(token)!, paid: true, ...over });
  }
  async verify(token: string): Promise<PaymentVerification> {
    const meanwhile = this.duringVerify;
    this.duringVerify = undefined;
    await meanwhile?.();
    return (
      this.sessions.get(token) ?? {
        paid: false,
        amount: { amount: 0, currency: 'NOK' },
        booking_id: null,
        reference: '',
      }
    );
  }
  async refund(req: RefundRequest) {
    this.refunds.push(req);
    if (this.failRefunds-- > 0) throw new Error('stripe is down');
  }
}

let n = 0;
const key = () => `pay-key-${++n}`;

async function holdDepositSlot(service: BookingService) {
  const { slots } = await service.searchAvailability({
    date: '2026-10-02',
    party_size: { total: 1 },
    offering_id: 'color-cut',
    time_from: '13:00',
    time_to: '13:00',
  });
  return service.hold({ slot_id: slots[0]!.slot_id, idempotency_key: key() });
}

function setup() {
  const clock = new ManualClock(NOW);
  const payments = new FakePayments();
  const service = new BookingService({ provider: createDemoSalonProvider(), clock, payments });
  const confirm = (booking_id: string, payment_token?: string) =>
    service.confirm({
      booking_id,
      idempotency_key: key(),
      user_confirmed: true,
      customer: CUSTOMER,
      ...(payment_token ? { payment_token } : {}),
    });
  const failure = async (p: Promise<unknown>) =>
    (await p.catch((e: BookingError) => e)) as BookingError;
  return { clock, payments, service, confirm, failure };
}

describe('deposits through a payment provider', () => {
  it('hands out a payment link, then confirms once it is paid, for this booking and amount', async () => {
    const { payments, service, confirm, failure } = setup();
    const hold = await holdDepositSlot(service);

    const asked = await failure(confirm(hold.booking_id));
    expect(asked.code).toBe('payment_required');
    const details = asked.details as { payment_url: string; payment_token: string };
    expect(details.payment_url).toBe(`https://pay.example/${details.payment_token}`);
    expect((await service.getBooking(hold.booking_id)).status).toBe('held');

    // The customer has not paid yet.
    expect((await failure(confirm(hold.booking_id, details.payment_token))).code).toBe(
      'payment_failed',
    );

    payments.pay(details.payment_token);
    const booking = await confirm(hold.booking_id, details.payment_token);
    expect(booking.status).toBe('confirmed');
    expect(booking.payment).toEqual({
      status: 'paid',
      amount: { amount: 30000, currency: 'NOK' },
      reference: `pi_${hold.booking_id}`,
    });
  });

  it('trusts nothing the agent sends: made-up tokens, someone else’s payment, a smaller amount', async () => {
    const { payments, service, confirm, failure } = setup();
    const hold = await holdDepositSlot(service);

    for (const token of ['tok_visa', 'manual:collected-in-studio', 'cs_made_up']) {
      const err = await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () =>
        failure(confirm(hold.booking_id, token)),
      );
      expect(err.code).toBe('payment_failed');
    }

    const other = await holdDepositSlot(service);
    payments.sessions.set('cs_other', {
      paid: true,
      amount: { amount: 30000, currency: 'NOK' },
      booking_id: other.booking_id,
      reference: 'pi_other',
    });
    expect((await failure(confirm(hold.booking_id, 'cs_other'))).code).toBe('payment_failed');

    const small: Money = { amount: 100, currency: 'NOK' };
    payments.sessions.set('cs_small', {
      paid: true,
      amount: small,
      booking_id: hold.booking_id,
      reference: 'pi_small',
    });
    expect((await failure(confirm(hold.booking_id, 'cs_small'))).code).toBe('payment_failed');
    expect((await service.getBooking(hold.booking_id)).status).toBe('held');
  });

  it('lets staff record a deposit taken in person in Studio, and nobody else', async () => {
    const { service, confirm } = setup();
    const hold = await holdDepositSlot(service);
    const booking = await runAsActor({ protocol: 'studio', agent: 'Studio' }, () =>
      confirm(hold.booking_id, 'manual:collected-in-studio'),
    );
    expect(booking.payment.status).toBe('paid');
  });

  it('refunds what the cancellation terms say, and retries a refund that failed without refunding twice', async () => {
    const { payments, service, confirm, failure } = setup();
    const hold = await holdDepositSlot(service);
    const asked = await failure(confirm(hold.booking_id));
    const token = (asked.details as { payment_token: string }).payment_token;
    payments.pay(token);
    await confirm(hold.booking_id, token);

    payments.failRefunds = 1;
    const cancel = () =>
      service.cancel({ booking_id: hold.booking_id, idempotency_key: key(), user_confirmed: true });
    const err = await failure(cancel());
    expect(err.code).toBe('refund_failed');
    expect(err.retryable).toBe(true);
    expect((await service.getBooking(hold.booking_id)).status).toBe('cancelled');

    // Cancelling again retries the refund, with the same Stripe idempotency key.
    const done = await cancel();
    expect(done.already_inactive).toBe(true);
    expect(payments.refunds).toHaveLength(2);
    expect(payments.refunds[0]).toEqual(payments.refunds[1]);
    expect(payments.refunds[1]).toMatchObject({
      reference: `pi_${hold.booking_id}`,
      amount: { amount: 30000, currency: 'NOK' },
      idempotency_key: `refund:${hold.booking_id}`,
    });
  });

  it('gives the money back when the customer pays after the hold ran out', async () => {
    const { clock, payments, service, confirm, failure } = setup();
    const hold = await holdDepositSlot(service);
    const asked = await failure(confirm(hold.booking_id));
    const token = (asked.details as { payment_token: string }).payment_token;

    clock.set(new Date(clock.now().getTime() + 11 * 60_000).toISOString());
    payments.pay(token);
    expect((await failure(confirm(hold.booking_id, token))).code).toBe('hold_expired');
    expect(payments.refunds).toEqual([
      {
        reference: `pi_${hold.booking_id}`,
        amount: { amount: 30000, currency: 'NOK' },
        idempotency_key: `refund:${hold.booking_id}`,
      },
    ]);
  });

  it('settles a payment nobody is waiting on: waits while the hold is live, then refunds once', async () => {
    const { clock, payments, service, confirm, failure } = setup();
    const hold = await holdDepositSlot(service);
    const asked = await failure(confirm(hold.booking_id));
    const token = (asked.details as { payment_token: string }).payment_token;

    // Not paid: nothing to give back, whatever the booking looks like.
    expect(await service.reconcilePayment(hold.booking_id, token)).toBe('pending');
    clock.set(new Date(clock.now().getTime() + 11 * 60_000).toISOString());
    expect(await service.reconcilePayment(hold.booking_id, token)).toBe('unpaid');
    expect(payments.refunds).toEqual([]);

    payments.pay(token);
    expect(await service.reconcilePayment(hold.booking_id, token)).toBe('refunded');
    expect(await service.reconcilePayment(hold.booking_id, token)).toBe('refunded');
    expect(new Set(payments.refunds.map((r) => r.idempotency_key))).toEqual(
      new Set([`refund:${hold.booking_id}`]),
    );

    // A payment for some other booking is not this booking's to refund.
    const other = await holdDepositSlot(service);
    clock.set(new Date(clock.now().getTime() + 11 * 60_000).toISOString());
    expect(await service.reconcilePayment(other.booking_id, token)).toBe('unpaid');
  });

  it('refunds nothing for a booking that never paid a deposit', async () => {
    const { payments, service, confirm } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '15:00',
      time_to: '15:00',
    });
    const hold = await service.hold({ slot_id: slots[0]!.slot_id, idempotency_key: key() });
    await confirm(hold.booking_id);
    await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    expect(payments.refunds).toEqual([]);
  });
});

describe('a deposit that was paid for a booking that then cannot be confirmed', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Hold, ask for the payment page and pay it. The booking is not confirmed yet. */
  async function paidHold(service: BookingService, payments: FakePayments) {
    const hold = await holdDepositSlot(service);
    const confirmWith = (idempotency_key: string, payment_token?: string) =>
      service
        .confirm({
          booking_id: hold.booking_id,
          idempotency_key,
          user_confirmed: true,
          customer: CUSTOMER,
          ...(payment_token ? { payment_token } : {}),
        })
        .catch((e: BookingError) => e);
    const asked = (await confirmWith(key())) as BookingError;
    const token = (asked.details as { payment_token: string }).payment_token;
    payments.pay(token);
    return { hold, token, confirm: (k: string) => confirmWith(k, token) };
  }

  /** While the payment is being checked the hold runs out and someone else takes the time. */
  function loseSlotDuringVerify({ clock, payments, service }: ReturnType<typeof setup>) {
    payments.duringVerify = async () => {
      clock.set(new Date(clock.now().getTime() + 11 * 60_000).toISOString());
      await holdDepositSlot(service);
    };
  }

  it('refunds in the same call and says plainly that nothing was booked', async () => {
    const s = setup();
    const { hold, confirm } = await paidHold(s.service, s.payments);
    loseSlotDuringVerify(s);

    const err = (await confirm(key())) as BookingError;
    expect(err.code).toBe('hold_expired');
    expect(err.message).toMatch(/not made/);
    expect(err.message).toMatch(/300\.00 NOK is being refunded/);
    expect(err.suggested_next_action).toMatch(/not made/);
    expect(err.suggested_next_action).toMatch(/refunded/);
    expect(s.payments.refunds).toEqual([
      {
        reference: `pi_${hold.booking_id}`,
        amount: { amount: 30000, currency: 'NOK' },
        idempotency_key: `refund:${hold.booking_id}`,
      },
    ]);
    expect((await s.service.getBooking(hold.booking_id)).status).toBe('expired');
  });

  it('never refunds twice: a retry with the same key and the webhook reuse the one refund key', async () => {
    const s = setup();
    const { hold, token, confirm } = await paidHold(s.service, s.payments);
    loseSlotDuringVerify(s);
    const sameKey = key();

    await confirm(sameKey);
    expect(s.payments.refunds).toHaveLength(1);

    expect(((await confirm(sameKey)) as BookingError).code).toBe('hold_expired');
    expect(await s.service.reconcilePayment(hold.booking_id, token)).toBe('refunded');
    // Every later attempt carries the first refund's key, which the payment provider pays once.
    for (const refund of s.payments.refunds) expect(refund).toEqual(s.payments.refunds[0]);
  });

  it('says so, and tells the business, when the refund itself fails; a retry tries again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup();
    const { hold, confirm } = await paidHold(s.service, s.payments);
    loseSlotDuringVerify(s);
    s.payments.failRefunds = 1;
    const sameKey = key();

    const err = (await confirm(sameKey)) as BookingError;
    expect(err.code).toBe('refund_failed');
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/not made/);
    expect(err.message).toMatch(/will be refunded/);
    expect(err.suggested_next_action).toMatch(/business has been told/);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain(hold.booking_id);
    expect(JSON.stringify(error.mock.calls)).not.toContain(CUSTOMER.email);
    expect(JSON.stringify(error.mock.calls)).not.toContain(CUSTOMER.last_name);

    expect(((await confirm(sameKey)) as BookingError).code).toBe('hold_expired');
    expect(s.payments.refunds).toHaveLength(2);
    expect(s.payments.refunds[1]).toEqual(s.payments.refunds[0]);
  });

  /** A service whose booking system fails `confirmHold` the way `fail` says, until switched off. */
  function flaky(fail: 'after_confirming' | 'before_confirming') {
    const payments = new FakePayments();
    const provider = createDemoSalonProvider();
    const confirmHold = provider.confirmHold.bind(provider);
    const state = { failing: true };
    provider.confirmHold = async (req, ctx) => {
      if (state.failing && fail === 'before_confirming') throw new Error('database is down');
      const confirmed = await confirmHold(req, ctx);
      if (state.failing) throw new Error('timed out');
      return confirmed;
    };
    const service = new BookingService({ provider, clock: new ManualClock(NOW), payments });
    return { payments, service, state };
  }

  it('never refunds a confirm that went through, even when the call reported a failure', async () => {
    const { payments, service, state } = flaky('after_confirming');
    const { hold, confirm } = await paidHold(service, payments);

    expect(((await confirm('lost-answer')) as BookingError).code).toBe('provider_error');
    expect(payments.refunds).toEqual([]);
    expect((await service.getBooking(hold.booking_id)).status).toBe('confirmed');

    state.failing = false;
    expect(await confirm('lost-answer')).toMatchObject({ status: 'confirmed' });
    expect(payments.refunds).toEqual([]);
  });

  it('keeps the money while the hold is still live: the booking can still be confirmed', async () => {
    const { payments, service, state } = flaky('before_confirming');
    const { confirm } = await paidHold(service, payments);

    expect(((await confirm('transient-blip')) as BookingError).code).toBe('provider_error');
    expect(payments.refunds).toEqual([]);

    state.failing = false;
    expect(await confirm('transient-blip')).toMatchObject({ status: 'confirmed' });
    expect(payments.refunds).toEqual([]);
  });
});

describe('deposits with no payment provider', () => {
  afterEach(() => vi.restoreAllMocks());

  function setupWithout(options: { demoPayments?: boolean } = {}) {
    const service = new BookingService({
      provider: new MemoryBookingProvider(demoSalonConfig(), options),
      clock: new ManualClock(NOW),
    });
    const confirm = (booking_id: string, payment_token: string) =>
      service.confirm({
        booking_id,
        idempotency_key: key(),
        user_confirmed: true,
        customer: CUSTOMER,
        payment_token,
      });
    const failure = async (p: Promise<unknown>) =>
      (await p.catch((e: BookingError) => e)) as BookingError;
    return { service, confirm, failure };
  }

  it('never records a deposit as paid from a token nobody checked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, confirm, failure } = setupWithout();
    const hold = await holdDepositSlot(service);

    for (const token of ['tok_visa', 'manual:collected-in-studio', 'cs_made_up']) {
      const err = await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () =>
        failure(confirm(hold.booking_id, token)),
      );
      expect(err.code).toBe('operation_not_supported');
      expect(err.suggested_next_action).toMatch(/nothing was charged/);
    }
    const booking = await service.getBooking(hold.booking_id);
    expect(booking.status).toBe('held');
    expect(booking.payment.status).not.toBe('paid');
    // The business is told why, once, and without customer details.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/no payment provider is configured/);
    expect(String(warn.mock.calls[0]![0])).not.toContain(CUSTOMER.email);
  });

  it('still lets staff record a deposit taken in person in Studio', async () => {
    const { service, confirm } = setupWithout();
    const hold = await holdDepositSlot(service);
    const booking = await runAsActor({ protocol: 'studio', agent: 'Studio' }, () =>
      confirm(hold.booking_id, 'manual:collected-in-studio'),
    );
    expect(booking.payment).toMatchObject({
      status: 'paid',
      reference: 'manual:collected-in-studio',
    });
  });

  it('accepts pretend tokens only when demoPayments is switched on', async () => {
    const { service, confirm, failure } = setupWithout({ demoPayments: true });
    const hold = await holdDepositSlot(service);
    expect((await failure(confirm(hold.booking_id, 'tok_fail_card'))).code).toBe('payment_failed');
    // "manual:" is for Studio only, with or without demo payments.
    const manual = await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () =>
      failure(confirm(hold.booking_id, 'manual:collected-in-studio')),
    );
    expect(manual.code).toBe('payment_failed');
    const booking = await confirm(hold.booking_id, 'tok_visa');
    expect(booking.payment.status).toBe('paid');
  });
});
