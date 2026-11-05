import { formatMoney, type Booking } from '@openbooking-sh/core';

/**
 * What the owner should know about the deposit on a booking, in one or two plain sentences, or
 * `null` when there is no deposit. It only restates what the booking records (status, amounts and
 * the cancellation terms that were applied): it cannot know whether Stripe's refund arrived, so
 * it says what is due and how to retry.
 */
export function paymentSummary(b: Booking): string | null {
  const { payment } = b;
  if (payment.status === 'not_required') return null;
  const amount = payment.amount ?? b.slot.deposit?.amount ?? null;
  const money = amount ? formatMoney(amount) : 'The deposit';

  if (payment.status === 'due_at_venue') return `${money} is due at the venue.`;

  if (payment.status === 'pending') {
    if (b.status === 'held') return `Waiting for the customer to pay ${money}.`;
    if (b.status === 'expired') return 'Not paid: the hold ran out before the customer paid.';
    return 'Not paid.';
  }

  // Paid. In person means staff recorded it in Studio, so it never went through Stripe.
  const inPerson = payment.reference?.startsWith('manual:') === true;
  const paid = `${inPerson ? 'Paid in person' : 'Paid online'}: ${money}.`;
  if (b.status !== 'cancelled' || !b.cancellation) return paid;

  const refund = b.cancellation.refund;
  if (!refund || refund.amount <= 0) return `${paid} Cancelled: no refund under the terms.`;
  const kept = amount ? Math.max(0, amount.amount - refund.amount) : 0;
  return [
    paid,
    `Cancelled: refund under the terms ${formatMoney(refund)}${kept > 0 ? `, ${formatMoney({ amount: kept, currency: refund.currency })} kept` : ''}.`,
    inPerson
      ? 'It was taken in person, so hand the refund back yourself.'
      : 'It is sent through Stripe. If it did not go through, cancel again to retry.',
  ].join(' ');
}
