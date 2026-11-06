import { describe, expect, it } from 'vitest';
import type { Booking } from '@openbooking-sh/core';
import { paymentSummary } from '../src/payment-summary';

const NOK = (amount: number) => ({ amount, currency: 'NOK' });

/** Only the parts the summary reads. */
function booking(over: {
  status: Booking['status'];
  payment: Booking['payment'];
  deposit?: boolean;
  cancellation?: Booking['cancellation'];
}): Booking {
  return {
    status: over.status,
    payment: over.payment,
    cancellation: over.cancellation ?? null,
    slot: { deposit: over.deposit === false ? null : { amount: NOK(30000) } },
  } as unknown as Booking;
}

const paid = (reference: string) => ({
  status: 'paid' as const,
  amount: NOK(30000),
  reference,
});

describe('paymentSummary', () => {
  it('says nothing when there is no deposit', () => {
    const none = { status: 'not_required' as const, amount: null, reference: null };
    expect(paymentSummary(booking({ status: 'confirmed', payment: none, deposit: false }))).toBe(
      null,
    );
  });

  it('says what a deposit that was not paid is waiting for', () => {
    const pending = { status: 'pending' as const, amount: null, reference: null };
    const text = (status: Booking['status']) =>
      paymentSummary(booking({ status, payment: pending }));
    expect(text('held')).toBe('Waiting for the customer to pay 300.00 NOK.');
    expect(text('expired')).toBe('Not paid: the hold ran out before the customer paid.');
    expect(text('cancelled')).toBe('Not paid.');
    const venue = { status: 'due_at_venue' as const, amount: null, reference: null };
    expect(paymentSummary(booking({ status: 'confirmed', payment: venue }))).toBe(
      '300.00 NOK is due at the venue.',
    );
  });

  it('tells an online payment from one taken in person', () => {
    expect(paymentSummary(booking({ status: 'confirmed', payment: paid('pi_1') }))).toBe(
      'Paid online: 300.00 NOK.',
    );
    expect(
      paymentSummary(booking({ status: 'confirmed', payment: paid('manual:collected-in-studio') })),
    ).toBe('Paid in person: 300.00 NOK.');
  });

  it('shows the refund the terms gave and what was kept, without claiming Stripe has paid it', () => {
    const cancelled = (refund: number | null, reference = 'pi_1') =>
      paymentSummary(
        booking({
          status: 'cancelled',
          payment: paid(reference),
          cancellation: {
            reason: null,
            fee: null,
            refund: refund === null ? null : NOK(refund),
          },
        }),
      );
    expect(cancelled(30000)).toBe(
      'Paid online: 300.00 NOK. Cancelled: refund under the terms 300.00 NOK. It is sent through Stripe. If it did not go through, cancel again to retry.',
    );
    expect(cancelled(10000)).toContain('refund under the terms 100.00 NOK, 200.00 NOK kept.');
    expect(cancelled(0)).toBe('Paid online: 300.00 NOK. Cancelled: no refund under the terms.');
    expect(cancelled(null)).toContain('no refund under the terms');
    // Taken in person: Stripe cannot send it back, so the owner is told to.
    expect(cancelled(10000, 'manual:collected-in-studio')).toContain(
      'hand the refund back yourself',
    );
  });
});
