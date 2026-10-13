import { describe, expect, it } from 'vitest';
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
import { createDemoSalonProvider } from '../src';

const NOW = '2026-10-01T06:00:00Z';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

/** A payment page that exists only in memory: `pay()` is the customer paying. */
class FakePayments implements PaymentProvider {
  sessions = new Map<string, PaymentVerification>();
  refunds: RefundRequest[] = [];
  failRefunds = 0;

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
