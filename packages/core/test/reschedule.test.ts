import { describe, expect, it } from 'vitest';
import {
  BookingError,
  BookingService,
  ManualClock,
  createWebhooks,
  type BookingEvent,
  type WebhookEvent,
} from '../src';
import { CUSTOMER, TinyProvider, slot } from './fixtures';

const SLOT_2 = slot({
  slot_id: 'slot-2',
  start: '2026-10-11T19:00:00+00:00',
  end: '2026-10-11T20:30:00+00:00',
});

function setup(slots = [slot(), SLOT_2]) {
  const clock = new ManualClock('2026-10-01T12:00:00Z');
  const provider = new TinyProvider(slots);
  const events: BookingEvent[] = [];
  const service = new BookingService({
    provider,
    clock,
    holdTtlSeconds: 300,
    onEvent: (e) => events.push(e),
  });
  return { clock, provider, service, events };
}

async function booked(service: BookingService, slotId = 'slot-1') {
  const hold = await service.hold({ slot_id: slotId, idempotency_key: `hold-${slotId}` });
  return service.confirm({
    booking_id: hold.booking_id,
    idempotency_key: `confirm-${slotId}`,
    user_confirmed: true,
    customer: CUSTOMER,
  });
}

async function failure(p: Promise<unknown>): Promise<BookingError> {
  const err = await p.then(
    () => {
      throw new Error('expected an error');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BookingError);
  return err as BookingError;
}

const code = async (p: Promise<unknown>) => (await failure(p)).code;

describe('reschedule', () => {
  it('moves a confirmed booking to a new slot and cancels the old one', async () => {
    const { service, provider } = setup();
    const old = await booked(service);

    const { booking, previous } = await service.reschedule({
      booking_id: old.booking_id,
      new_slot_id: 'slot-2',
      idempotency_key: 'resched-1',
      user_confirmed: true,
    });

    expect(booking.status).toBe('confirmed');
    expect(booking.slot.slot_id).toBe('slot-2');
    expect(booking.customer).toEqual(CUSTOMER);
    expect(booking.booking_id).not.toBe(old.booking_id);
    expect(previous.status).toBe('cancelled');
    expect(previous.cancellation?.reason).toBe('rescheduled');
    expect(previous.cancellation?.fee).toBeNull(); // still inside the free window
    // The old slot is free again.
    expect(await provider.searchAvailability()).toContainEqual(
      expect.objectContaining({ slot_id: 'slot-1' }),
    );
  });

  it('needs explicit consent, and shows the late fee before charging it', async () => {
    const { service, clock } = setup();
    const old = await booked(service);
    clock.set('2026-10-09T20:00:00Z'); // after the free window, before the start

    const err = await failure(
      service.reschedule({
        booking_id: old.booking_id,
        new_slot_id: 'slot-2',
        idempotency_key: 'resched-2',
        user_confirmed: false,
      }),
    );
    expect(err.code).toBe('user_confirmation_required');
    expect(err.details?.fee).toEqual({ amount: 20000, currency: 'NOK' });

    const { previous } = await service.reschedule({
      booking_id: old.booking_id,
      new_slot_id: 'slot-2',
      idempotency_key: 'resched-3',
      user_confirmed: true,
    });
    expect(previous.cancellation?.fee).toEqual({ amount: 20000, currency: 'NOK' });
  });

  it('changes nothing when the new slot is taken', async () => {
    const { service, provider } = setup();
    const old = await booked(service);
    await booked(service, 'slot-2'); // someone else takes it

    expect(
      await code(
        service.reschedule({
          booking_id: old.booking_id,
          new_slot_id: 'slot-2',
          idempotency_key: 'resched-4',
          user_confirmed: true,
        }),
      ),
    ).toBe('slot_unavailable');
    expect(provider.bookings.get(old.booking_id)!.status).toBe('confirmed');
  });

  it('gives the new slot back when cancelling the old booking fails', async () => {
    const { service, provider } = setup();
    const old = await booked(service);
    const realCancel = provider.cancelBooking.bind(provider);
    provider.cancelBooking = async (req, ctx) => {
      if (req.booking_id === old.booking_id) throw new BookingError('provider_error', 'boom');
      return realCancel(req, ctx);
    };

    expect(
      await code(
        service.reschedule({
          booking_id: old.booking_id,
          new_slot_id: 'slot-2',
          idempotency_key: 'resched-5',
          user_confirmed: true,
        }),
      ),
    ).toBe('provider_error');
    const active = [...provider.bookings.values()].filter((b) => b.status === 'confirmed');
    expect(active.map((b) => b.booking_id)).toEqual([old.booking_id]);
  });

  it('retries with the same key never move the booking twice', async () => {
    const { service, provider } = setup();
    const old = await booked(service);
    const input = {
      booking_id: old.booking_id,
      new_slot_id: 'slot-2',
      idempotency_key: 'resched-6',
      user_confirmed: true,
    };
    const first = await service.reschedule(input);
    const holds = provider.calls.createHold;
    const second = await service.reschedule(input);
    expect(second.booking.booking_id).toBe(first.booking.booking_id);
    expect(provider.calls.createHold).toBe(holds);
  });

  it('refuses holds, paid deposits, deposits at confirmation and started bookings', async () => {
    const withDeposit = slot({
      slot_id: 'slot-3',
      start: '2026-10-12T19:00:00+00:00',
      end: '2026-10-12T20:30:00+00:00',
      deposit: {
        amount: { amount: 5000, currency: 'NOK' },
        due: 'at_confirmation',
        description: 'Deposit',
      },
    });
    const { service, provider, clock } = setup([slot(), SLOT_2, withDeposit]);
    const old = await booked(service);
    const reschedule = (id: string, to: string, key: string) =>
      service.reschedule({
        booking_id: id,
        new_slot_id: to,
        idempotency_key: key,
        user_confirmed: true,
      });

    const hold = await service.hold({ slot_id: 'slot-2', idempotency_key: 'hold-key-h2' });
    expect(await code(reschedule(hold.booking_id, 'slot-3', 'resched-held'))).toBe('invalid_state');

    expect(await code(reschedule(old.booking_id, 'slot-3', 'resched-deposit'))).toBe(
      'operation_not_supported',
    );
    // The deposit hold that was probed is released again.
    expect(
      [...provider.bookings.values()].filter(
        (b) => b.slot.slot_id === 'slot-3' && b.status === 'held',
      ),
    ).toHaveLength(0);

    provider.bookings.get(old.booking_id)!.payment = {
      status: 'paid',
      amount: { amount: 5000, currency: 'NOK' },
      reference: 'pay_1',
    };
    expect(await code(reschedule(old.booking_id, 'slot-2', 'resched-paid'))).toBe(
      'operation_not_supported',
    );

    clock.set('2026-10-10T19:30:00Z');
    expect(await code(reschedule(old.booking_id, 'slot-2', 'resched-started'))).toBe(
      'cancellation_not_allowed',
    );
  });

  it('emits confirm and cancel events, so calendar sync and emails keep working', async () => {
    const { service, events } = setup();
    const old = await booked(service);
    events.length = 0;
    const { booking } = await service.reschedule({
      booking_id: old.booking_id,
      new_slot_id: 'slot-2',
      idempotency_key: 'resched-7',
      user_confirmed: true,
    });
    const seen = events.map((e) => `${e.operation}:${e.booking_id}:${e.status}`);
    expect(seen).toContain(`confirm:${booking.booking_id}:confirmed`);
    expect(seen).toContain(`cancel:${old.booking_id}:cancelled`);
    expect(seen).toContain(`reschedule:${booking.booking_id}:confirmed`);
  });
  it('sends one booking.rescheduled webhook, not a confirmed and a cancelled', async () => {
    const sent: WebhookEvent[] = [];
    const webhooks = createWebhooks({
      endpoints: [{ url: 'https://crm.example/hooks', secret: 'whsec_test_0123456789' }],
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response('ok');
      }) as typeof fetch,
    });
    const { service } = setup();
    service.on(webhooks.listener);
    const old = await booked(service);
    const { booking } = await service.reschedule({
      booking_id: old.booking_id,
      new_slot_id: 'slot-2',
      idempotency_key: 'resched-wh1',
      user_confirmed: true,
    });
    await webhooks.idle();

    expect(sent.map((e) => e.type)).toEqual([
      'booking.held',
      'booking.confirmed',
      'booking.rescheduled',
    ]);
    const moved = sent[2]!;
    expect(moved.data.booking.booking_id).toBe(booking.booking_id);
    expect(moved.data.previous_booking?.booking_id).toBe(old.booking_id);
    expect(moved.data.previous_booking?.status).toBe('cancelled');
  });
});
