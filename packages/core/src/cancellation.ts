import type { Booking, CancellationPolicy, Money } from './schemas';

export type CancellationOutcome =
  | {
      allowed: true;
      /** True when cancelling now costs nothing. */
      free: boolean;
      fee: Money | null;
      /** Amount returned to the customer from a paid deposit, if any. */
      refund: Money | null;
    }
  | { allowed: false; reason: 'already_started' };

/**
 * Pure cancellation rules for a confirmed booking:
 *  - At or after the start time → not cancellable online (no-show rules apply).
 *  - Before `free_cancellation_until` (and policy not `non_refundable`) → free, full deposit refund.
 *  - Otherwise → `late_cancellation_fee` applies (for `non_refundable` without an explicit fee, the
 *    whole paid deposit is retained); refund = paid deposit − fee, floored at zero.
 */
export function evaluateCancellation(args: {
  policy: CancellationPolicy;
  start: string | Date;
  now: Date;
  paidDeposit: Money | null;
}): CancellationOutcome {
  const { policy, now, paidDeposit } = args;
  const start = new Date(args.start).getTime();
  if (now.getTime() >= start) return { allowed: false, reason: 'already_started' };

  const freeUntil = policy.free_cancellation_until
    ? new Date(policy.free_cancellation_until).getTime()
    : null;
  const free =
    policy.refundability !== 'non_refundable' && freeUntil !== null && now.getTime() < freeUntil;

  if (free) return { allowed: true, free: true, fee: null, refund: paidDeposit };

  let fee: Money | null = policy.late_cancellation_fee;
  if (!fee && policy.refundability === 'non_refundable' && paidDeposit) fee = paidDeposit;

  const refund = paidDeposit
    ? {
        amount: Math.max(0, paidDeposit.amount - (fee?.amount ?? 0)),
        currency: paidDeposit.currency,
      }
    : null;

  return { allowed: true, free: fee === null || fee.amount === 0, fee, refund };
}

/** Convenience wrapper for a booking snapshot. */
export function evaluateBookingCancellation(booking: Booking, now: Date): CancellationOutcome {
  return evaluateCancellation({
    policy: booking.slot.cancellation_policy,
    start: booking.slot.start,
    now,
    paidDeposit: booking.payment.status === 'paid' ? booking.payment.amount : null,
  });
}
