import { describe, expect, it } from 'vitest';
import { BookingError, BookingService, ManualClock, type BookingEvent } from '../src';
import { CUSTOMER, TinyProvider, slot } from './fixtures';

function setup(opts: { holdTtlSeconds?: number; provider?: TinyProvider } = {}) {
  const clock = new ManualClock('2026-10-01T12:00:00Z');
  const provider = opts.provider ?? new TinyProvider();
  const events: BookingEvent[] = [];
  const service = new BookingService({
    provider,
    clock,
    holdTtlSeconds: opts.holdTtlSeconds ?? 300,
    onEvent: (e) => events.push(e),
  });
  return { clock, provider, service, events };
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => {
      throw new Error(`expected ${code}, but call succeeded`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BookingError);
  expect((err as BookingError).code).toBe(code);
  expect((err as BookingError).suggested_next_action.length).toBeGreaterThan(10);
  return err as BookingError;
}

describe('lifecycle: search → hold → confirm → cancel', () => {
  it('completes the happy path', async () => {
    const { service, clock } = setup();
    const { venue, slots } = await service.searchAvailability({
      date: '2026-10-10',
      party_size: { total: 2 },
    });
    expect(venue.id).toBe('v1');
    expect(slots).toHaveLength(1);
    expect(slots[0]!.cancellation_policy.refundability).toBe('refundable');

    const hold = await service.hold({ slot_id: slots[0]!.slot_id, idempotency_key: 'hold-key-1' });
    expect(hold.status).toBe('held');
    expect(hold.expires_at).toBe(new Date(clock.now().getTime() + 300_000).toISOString());

    const confirmed = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
      customer: CUSTOMER,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmation_code).toBeTruthy();

    const { booking } = await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: 'cancel-key-1',
      user_confirmed: true,
    });
    expect(booking.status).toBe('cancelled');
    expect(booking.cancellation?.fee).toBeNull(); // > 24h before start → free
  });

  it('validates input with an actionable message', async () => {
    const { service } = setup();
    const err = await expectCode(
      service.searchAvailability({ date: '10/10/2026', party_size: { total: 0 } }),
      'validation_error',
    );
    expect(err.message).toContain('date');
    expect(err.message).toContain('party_size.total');
  });
});

describe('hold expiry', () => {
  it('rejects confirming an expired hold and reports status expired', async () => {
    const { service, clock, events } = setup({ holdTtlSeconds: 60 });
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });

    clock.advanceSeconds(61);
    expect((await service.getBooking(hold.booking_id)).status).toBe('expired');

    await expectCode(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
        customer: CUSTOMER,
      }),
      'hold_expired',
    );
    expect(events.at(-1)).toMatchObject({
      operation: 'confirm',
      ok: false,
      error_code: 'hold_expired',
    });
  });

  it('frees inventory after expiry so the slot can be held again', async () => {
    const { service, clock } = setup({ holdTtlSeconds: 60 });
    await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    await expectCode(
      service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-2' }),
      'slot_unavailable',
    );
    clock.advanceSeconds(60);
    const second = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-3' });
    expect(second.status).toBe('held');
  });

  it('confirms just before expiry', async () => {
    const { service, clock } = setup({ holdTtlSeconds: 60 });
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    clock.advanceSeconds(59);
    const ok = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    });
    expect(ok.status).toBe('confirmed');
    expect(ok.expires_at).toBeNull();
  });
});

describe('idempotency', () => {
  it('replays a hold retried with the same key without creating a second hold', async () => {
    const { service, provider, events } = setup();
    const a = await service.hold({ slot_id: 'slot-1', idempotency_key: 'same-key-123' });
    const b = await service.hold({ slot_id: 'slot-1', idempotency_key: 'same-key-123' });
    expect(b.booking_id).toBe(a.booking_id);
    expect(provider.calls.createHold).toBe(1);
    expect(events.at(-1)).toMatchObject({ operation: 'hold', ok: true, replayed: true });
  });

  it('dedupes concurrent calls with the same key', async () => {
    const { service, provider } = setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.hold({ slot_id: 'slot-1', idempotency_key: 'race-key-123' }),
      ),
    );
    expect(new Set(results.map((r) => r.booking_id)).size).toBe(1);
    expect(provider.calls.createHold).toBe(1);
  });

  it('rejects reusing a key for a different request', async () => {
    const { service } = setup({
      provider: new TinyProvider([slot(), slot({ slot_id: 'slot-2' })]),
    });
    await service.hold({ slot_id: 'slot-1', idempotency_key: 'reused-key-1' });
    await expectCode(
      service.hold({ slot_id: 'slot-2', idempotency_key: 'reused-key-1' }),
      'idempotency_conflict',
    );
  });

  it('never double-confirms: retries (same or new key) return the same confirmed booking', async () => {
    const { service, provider } = setup();
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    const input = {
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    };
    const first = await service.confirm(input);
    const retry = await service.confirm(input);
    const freshKey = await service.confirm({ ...input, idempotency_key: 'confirm-key-2' });
    expect(retry.confirmation_code).toBe(first.confirmation_code);
    expect(freshKey.confirmation_code).toBe(first.confirmation_code);
    expect(provider.calls.confirmHold).toBe(1);
  });

  it('does not cache failures: same key can be retried after fixing the request', async () => {
    const { service } = setup();
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    await expectCode(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: false,
      }),
      'user_confirmation_required',
    );
    const ok = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    });
    expect(ok.status).toBe('confirmed');
  });

  it('returns current state on replay (hold replay after expiry shows expired)', async () => {
    const { service, clock } = setup({ holdTtlSeconds: 60 });
    await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    clock.advanceSeconds(120);
    const replay = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    expect(replay.status).toBe('expired');
  });

  it('expires idempotency records after the TTL', async () => {
    const { service, clock, provider } = setup({ holdTtlSeconds: 60 });
    await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    clock.advance(24 * 60 * 60 * 1000 + 1);
    await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    expect(provider.calls.createHold).toBe(2);
  });
});

describe('confirmation guards', () => {
  it('never auto-confirms: user_confirmed must be true', async () => {
    const { service, provider } = setup();
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    const err = await expectCode(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: false,
      }),
      'user_confirmation_required',
    );
    expect(err.details?.summary).toMatchObject({
      cancellation_policy: { refundability: 'refundable' },
    });
    expect(provider.calls.confirmHold).toBe(0);
  });

  it('requires customer details', async () => {
    const { service } = setup();
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    await expectCode(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
      }),
      'customer_details_required',
    );
  });

  it('requires a payment token when a deposit is due at confirmation', async () => {
    const deposit = {
      amount: { amount: 50000, currency: 'NOK' },
      due: 'at_confirmation' as const,
      description: 'Deposit',
    };
    const { service } = setup({ provider: new TinyProvider([slot({ deposit })]) });
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    await expectCode(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
      }),
      'payment_required',
    );
    const ok = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
      payment_token: 'tok_test',
    });
    expect(ok.payment.status).toBe('paid');
  });

  it('rejects confirming a cancelled booking', async () => {
    const { service } = setup();
    const hold = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
    });
    await service.cancel({ booking_id: hold.booking_id, idempotency_key: 'cancel-key-1' });
    await expectCode(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
      }),
      'invalid_state',
    );
  });
});

describe('update', () => {
  it('updates customer details on a held booking', async () => {
    const { service } = setup();
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    const updated = await service.update({
      booking_id: hold.booking_id,
      idempotency_key: 'update-key-1',
      customer: CUSTOMER,
    });
    expect(updated.customer?.email).toBe('ada@example.com');
  });
});
