import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { demoSalonConfig, MemoryBookingProvider, type ResourceSchedule } from '../src';

// Thursday 2026-10-01 08:00 Oslo time. Free cancellation (and so moving) ends 24 h before.
const NOW = '2026-10-01T06:00:00Z';
const FRIDAY = '2026-10-02';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup(schedules: Record<string, ResourceSchedule> = {}) {
  const config = demoSalonConfig();
  config.venues[0]!.schedules = schedules;
  const provider = new MemoryBookingProvider(config);
  const clock = new ManualClock(NOW);
  return { service: new BookingService({ provider, clock }), clock };
}

let n = 0;
const key = () => `resched-key-${++n}`;

async function slotAt(
  service: BookingService,
  at: string,
  opts: { offering?: string; staff?: string; date?: string } = {},
) {
  const { slots } = await service.searchAvailability({
    date: opts.date ?? FRIDAY,
    party_size: { total: 1 },
    offering_id: opts.offering ?? 'haircut',
    time_from: at,
    time_to: at,
    ...(opts.staff ? { tags: [opts.staff] } : {}),
  });
  if (!slots[0]) throw new Error(`no slot at ${at}`);
  return slots[0];
}

async function bookAt(service: BookingService, at: string, staff = 'maria', date = FRIDAY) {
  const slot = await slotAt(service, at, { staff, date });
  const hold = await service.hold({ slot_id: slot.slot_id, idempotency_key: key() });
  return service.confirm({
    booking_id: hold.booking_id,
    idempotency_key: key(),
    user_confirmed: true,
    customer: CUSTOMER,
  });
}

describe('rescheduling', () => {
  it('moves a confirmed booking, keeping its id and code, and frees the old time', async () => {
    const { service } = setup();
    const booking = await bookAt(service, '10:00', 'maria', '2026-10-06');
    const target = await slotAt(service, '14:00', { staff: 'maria', date: '2026-10-06' });

    const moved = await service.reschedule({
      booking_id: booking.booking_id,
      slot_id: target.slot_id,
      idempotency_key: 'move-key-1',
      user_confirmed: true,
    });
    expect(moved).toMatchObject({
      booking_id: booking.booking_id,
      confirmation_code: booking.confirmation_code,
      status: 'confirmed',
      slot: { start: '2026-10-06T14:00:00+02:00', resource: { label: 'Maria' } },
    });
    // A retry with the same key is a replay, not a second move.
    const again = await service.reschedule({
      booking_id: booking.booking_id,
      slot_id: target.slot_id,
      idempotency_key: 'move-key-1',
      user_confirmed: true,
    });
    expect(again.slot.start).toBe(moved.slot.start);
    // Maria is free at 10:00 again and busy at 14:00.
    expect(
      (await slotAt(service, '10:00', { staff: 'maria', date: '2026-10-06' })).resource?.label,
    ).toBe('Maria');
    const { slots } = await service.searchAvailability({
      date: '2026-10-06',
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '14:00',
      time_to: '14:00',
      tags: ['maria'],
    });
    expect(slots).toEqual([]);
    expect((await service.getBooking(booking.booking_id)).slot.start).toBe(
      '2026-10-06T14:00:00+02:00',
    );
  });

  it('needs the user to approve the new time', async () => {
    const { service } = setup();
    const booking = await bookAt(service, '10:00', 'maria', '2026-10-06');
    const target = await slotAt(service, '14:00', { date: '2026-10-06' });
    await expect(
      service.reschedule({
        booking_id: booking.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
      }),
    ).rejects.toMatchObject({ code: 'user_confirmation_required' });
  });

  it('refuses inside the late window, so moving cannot dodge the cancellation terms', async () => {
    const { service, clock } = setup();
    // Friday 10:00 is booked 26 hours ahead, while free cancellation still applies.
    const booking = await bookAt(service, '10:00');
    const target = await slotAt(service, '15:00');
    clock.set('2026-10-02T05:00:00Z'); // Friday 07:00: 3 hours before, inside the late window
    await expect(
      service.reschedule({
        booking_id: booking.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'reschedule_not_allowed' });
    clock.set(NOW);
    await expect(
      service.reschedule({
        booking_id: booking.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('rejects holds, other services and taken times, leaving the booking where it was', async () => {
    const { service } = setup();
    const booking = await bookAt(service, '10:00', 'maria', '2026-10-06');

    const other = await slotAt(service, '14:00', { offering: 'beard-trim', date: '2026-10-06' });
    await expect(
      service.reschedule({
        booking_id: booking.booking_id,
        slot_id: other.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // Someone else books Maria at 14:00 after we searched.
    const target = await slotAt(service, '14:00', { staff: 'maria', date: '2026-10-06' });
    await bookAt(service, '14:00', 'maria', '2026-10-06');
    await expect(
      service.reschedule({
        booking_id: booking.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
    expect((await service.getBooking(booking.booking_id)).slot.start).toBe(
      '2026-10-06T10:00:00+02:00',
    );

    const hold = await service.hold({
      slot_id: (await slotAt(service, '16:00', { date: '2026-10-06' })).slot_id,
      idempotency_key: key(),
    });
    await expect(
      service.reschedule({
        booking_id: hold.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('respects staff time off when moving to a specific person', async () => {
    const { service: before } = setup();
    const target = await slotAt(before, '15:00', { staff: 'maria', date: '2026-10-06' });
    const { service } = setup({
      maria: { time_off: [{ start: '2026-10-06T14:00', end: '2026-10-06T18:00' }] },
    });
    const booking = await bookAt(service, '10:00', 'maria', '2026-10-06');
    await expect(
      service.reschedule({
        booking_id: booking.booking_id,
        slot_id: target.slot_id,
        idempotency_key: key(),
        user_confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });
});
