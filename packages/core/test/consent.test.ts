import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, runAsActor, type BookingEvent } from '../src';
import { CUSTOMER, TinyProvider, slot } from './fixtures';

const priced = () =>
  slot({
    price: { amount: 65000, currency: 'NOK' },
    deposit: null,
  });

function setup(now = '2026-10-01T12:00:00Z') {
  const clock = new ManualClock(now);
  const service = new BookingService({ provider: new TinyProvider([priced()]), clock });
  const events: BookingEvent[] = [];
  service.on((e) => events.push(e));
  return { service, events, clock };
}

describe('consent evidence', () => {
  it('records the terms the user approved on confirm, with no customer details', async () => {
    const { service, events } = setup();
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () =>
      service.confirm({
        booking_id: hold.booking_id,
        customer: CUSTOMER,
        user_confirmed: true,
        idempotency_key: 'confirm-key-1',
      }),
    );

    const confirm = events.find((e) => e.operation === 'confirm')!;
    expect(confirm.consent).toMatchObject({
      user_confirmed: true,
      terms: {
        offering: 'Dinner',
        party_size: 2,
        price: { amount: 65000, currency: 'NOK' },
        cancellation_policy: { description: 'Free cancellation until 24h before.' },
      },
    });
    // The log keeps who agreed to what, never who the customer is.
    expect(JSON.stringify(confirm.consent)).not.toMatch(/Ada|Lovelace|ada@example\.com/);
  });

  it('records nothing when the user was not asked, and nothing on a replay', async () => {
    const { service, events } = setup();
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    await service
      .confirm({
        booking_id: hold.booking_id,
        customer: CUSTOMER,
        user_confirmed: false as never,
        idempotency_key: 'confirm-key-0',
      })
      .catch(() => {});
    const input = {
      booking_id: hold.booking_id,
      customer: CUSTOMER,
      user_confirmed: true as const,
      idempotency_key: 'confirm-key-1',
    };
    await service.confirm(input);
    await service.confirm(input);

    const confirms = events.filter((e) => e.operation === 'confirm');
    expect(confirms.map((e) => [e.ok, e.replayed ?? false, e.consent !== undefined])).toEqual([
      [false, false, false],
      [true, false, true],
      [true, true, false],
    ]);
  });

  it('records the fee the user accepted when cancelling late', async () => {
    const { service, events, clock } = setup();
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    await service.confirm({
      booking_id: hold.booking_id,
      customer: CUSTOMER,
      user_confirmed: true,
      idempotency_key: 'confirm-key-1',
    });
    clock.set('2026-10-10T10:00:00Z'); // inside the last 24 hours
    await service.cancel({
      booking_id: hold.booking_id,
      user_confirmed: true,
      idempotency_key: 'cancel-key-1',
    });

    const cancel = events.find((e) => e.operation === 'cancel')!;
    expect(cancel.consent).toMatchObject({
      user_confirmed: true,
      fee: { amount: 20000, currency: 'NOK' },
    });
  });

  it('does not record consent for releasing a hold, which needs none', async () => {
    const { service, events } = setup();
    const hold = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    await service.cancel({ booking_id: hold.booking_id, idempotency_key: 'cancel-key-1' });
    expect(events.find((e) => e.operation === 'cancel')!.consent).toBeUndefined();
  });
});
