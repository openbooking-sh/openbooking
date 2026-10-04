import { describe, expect, it } from 'vitest';
import type { BookingError } from '../src';
import { BookingService, ManualClock, evaluateCancellation } from '../src';
import { CUSTOMER, START, TinyProvider, policy, slot } from './fixtures';

const NOK = (amount: number) => ({ amount, currency: 'NOK' });

describe('evaluateCancellation (pure rules)', () => {
  const base = { policy: policy(), start: START, paidDeposit: null };

  it('is free before the free-cancellation deadline', () => {
    expect(evaluateCancellation({ ...base, now: new Date('2026-10-09T18:59:59Z') })).toEqual({
      allowed: true,
      free: true,
      fee: null,
      refund: null,
    });
  });

  it('charges the late fee after the deadline, before start', () => {
    const r = evaluateCancellation({ ...base, now: new Date('2026-10-09T19:00:00Z') });
    expect(r).toEqual({ allowed: true, free: false, fee: NOK(20000), refund: null });
  });

  it('is not allowed at or after start time', () => {
    expect(evaluateCancellation({ ...base, now: new Date(START) })).toEqual({
      allowed: false,
      reason: 'already_started',
    });
  });

  it('refunds the full deposit when free, deposit minus fee when late', () => {
    const paid = NOK(50000);
    expect(
      evaluateCancellation({ ...base, paidDeposit: paid, now: new Date('2026-10-08T00:00:00Z') }),
    ).toMatchObject({ free: true, refund: NOK(50000) });
    expect(
      evaluateCancellation({ ...base, paidDeposit: paid, now: new Date('2026-10-10T10:00:00Z') }),
    ).toMatchObject({ free: false, fee: NOK(20000), refund: NOK(30000) });
  });

  it('never refunds below zero', () => {
    const r = evaluateCancellation({
      ...base,
      paidDeposit: NOK(10000),
      now: new Date('2026-10-10T10:00:00Z'),
    });
    expect(r).toMatchObject({ refund: NOK(0) });
  });

  it('non_refundable keeps the whole deposit even before the deadline', () => {
    const r = evaluateCancellation({
      policy: policy({ refundability: 'non_refundable', late_cancellation_fee: null }),
      start: START,
      paidDeposit: NOK(50000),
      now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(r).toMatchObject({ allowed: true, free: false, fee: NOK(50000), refund: NOK(0) });
  });
});

describe('cancel via BookingService', () => {
  async function confirmedBooking(now: string) {
    const clock = new ManualClock('2026-10-01T12:00:00Z');
    const provider = new TinyProvider([slot()]);
    const service = new BookingService({ provider, clock });
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    });
    clock.set(now);
    return { service, provider, id: hold.booking_id };
  }

  it('releases a hold without user confirmation and without fee', async () => {
    const service = new BookingService({
      provider: new TinyProvider(),
      clock: new ManualClock('2026-10-01T12:00:00Z'),
    });
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    const { booking } = await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: 'cancel-key-1',
    });
    expect(booking.status).toBe('cancelled');
    expect(booking.cancellation).toMatchObject({ fee: null, refund: null });
  });

  it('requires user confirmation to cancel a confirmed booking and states the fee', async () => {
    const { service, provider, id } = await confirmedBooking('2026-10-10T12:00:00Z');
    const err = (await service
      .cancel({ booking_id: id, idempotency_key: 'cancel-key-1' })
      .catch((e: unknown) => e)) as BookingError;
    expect(err.code).toBe('user_confirmation_required');
    expect(err.message).toContain('200.00 NOK');
    expect(err.details).toMatchObject({ fee: NOK(20000), free: false });
    expect(provider.calls.cancelBooking).toBe(0);

    const { booking } = await service.cancel({
      booking_id: id,
      idempotency_key: 'cancel-key-1',
      user_confirmed: true,
    });
    expect(booking.cancellation?.fee).toEqual(NOK(20000));
  });

  it('refuses online cancellation after the booking started', async () => {
    const { service, id } = await confirmedBooking('2026-10-10T19:30:00Z');
    const err = (await service
      .cancel({ booking_id: id, idempotency_key: 'cancel-key-1', user_confirmed: true })
      .catch((e: unknown) => e)) as BookingError;
    expect(err.code).toBe('cancellation_not_allowed');
  });

  it('cancelling twice is a no-op that never charges twice', async () => {
    const { service, provider, id } = await confirmedBooking('2026-10-02T12:00:00Z');
    await service.cancel({ booking_id: id, idempotency_key: 'cancel-key-1', user_confirmed: true });
    const second = await service.cancel({
      booking_id: id,
      idempotency_key: 'cancel-key-2',
      user_confirmed: true,
    });
    expect(second.already_inactive).toBe(true);
    expect(provider.calls.cancelBooking).toBe(1);
  });
});
