import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, type BookingError } from '@openbooking/core';
import { CalcomBookingProvider } from '../src';
import { createFakeCal } from './fake-cal';

const VENUE = { id: 'studio-nord', name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' };
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup(opts: { apiKey?: string } = {}) {
  const cal = createFakeCal();
  const provider = new CalcomBookingProvider({
    apiKey: opts.apiKey ?? 'test-key',
    baseUrl: 'https://cal.test',
    fetch: cal.fetch,
    venue: VENUE,
  });
  const clock = new ManualClock('2026-10-01T06:00:00Z');
  const service = new BookingService({ provider, clock, holdTtlSeconds: 600 });
  return { cal, provider, service, clock };
}

let n = 0;
const key = () => `cal-key-${++n}`;
const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as BookingError,
  );

describe('Cal.com provider', () => {
  it('maps visible event types and slots into local-time OpenBooking slots', async () => {
    const { service } = setup();
    const { venue, slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
      limit: 50,
    });
    expect(venue.name).toBe('Studio Nord');
    expect(slots.map((s) => s.start)).toEqual([
      '2026-10-02T00:30:00+02:00',
      '2026-10-02T09:00:00+02:00',
      '2026-10-02T10:00:00+02:00',
      '2026-10-02T15:00:00+02:00',
    ]);
    expect(slots[1]).toMatchObject({
      offering: { id: '11', name: 'Haircut' },
      end: '2026-10-02T09:45:00+02:00',
      price: { amount: 65000, currency: 'NOK' },
      deposit: null,
      cancellation_policy: { free_cancellation_until: '2026-10-01T09:00:00+02:00' },
    });
  });

  it('hides hidden event types and filters by time window', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      time_from: '15:00',
      time_to: '15:00',
    });
    expect(slots.map((s) => s.offering.name).sort()).toEqual(['Beard trim', 'Haircut']);
    expect(slots.find((s) => s.offering.name === 'Beard trim')!.price).toBeNull();
  });

  it('runs hold → confirm → cancel against Cal.com', async () => {
    const { service, cal } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
      time_from: '15:00',
      time_to: '15:00',
    });
    const hold = await service.hold({ slot_id: slots[0]!.slot_id, idempotency_key: key() });
    expect(hold.status).toBe('held');
    const [reservation] = [...cal.reservations.values()];
    expect(reservation).toEqual({
      eventTypeId: 11,
      slotStart: '2026-10-02T13:00:00.000Z',
      reservationDuration: 10,
    });

    const confirmed = await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
      customer: { ...CUSTOMER, phone_number: '+4791234567' },
    });
    expect(confirmed.status).toBe('confirmed');
    expect(cal.reservations.size).toBe(0); // reservation released after booking
    const [calBooking] = [...cal.bookings.values()];
    expect(calBooking).toMatchObject({
      start: '2026-10-02T13:00:00.000Z',
      eventTypeId: 11,
      attendee: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        timeZone: 'Europe/Oslo',
        phoneNumber: '+4791234567',
      },
      metadata: { openbooking_booking_id: hold.booking_id },
    });
    expect(confirmed.confirmation_code).toBe(calBooking!.uid.slice(0, 8).toUpperCase());

    const { booking } = await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
      reason: 'Plans changed',
    });
    expect(booking.status).toBe('cancelled');
    expect(calBooking!.status).toBe('cancelled');
    expect(calBooking!.cancellationReason).toBe('Plans changed');
  });

  it('releases the Cal.com reservation when a hold is released', async () => {
    const { service, cal } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
    });
    const hold = await service.hold({ slot_id: slots[1]!.slot_id, idempotency_key: key() });
    expect(cal.reservations.size).toBe(1);
    await service.cancel({ booking_id: hold.booking_id, idempotency_key: key() });
    expect(cal.reservations.size).toBe(0);
  });

  it('never double-holds the same slot, even concurrently', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        service.hold({ slot_id: slots[1]!.slot_id, idempotency_key: key() }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]).every(
        (r) => (r.reason as BookingError).code === 'slot_unavailable',
      ),
    ).toBe(true);
  });

  it('reports slot_unavailable when the slot was booked directly in Cal.com', async () => {
    const { service, cal } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
    });
    cal.externalBooking(11, '2026-10-02T07:00:00Z');
    const err = await fail(service.hold({ slot_id: slots[1]!.slot_id, idempotency_key: key() }));
    expect(err?.code).toBe('slot_unavailable');
    expect(err?.suggested_next_action).toContain('search_availability');
  });

  it('asks for an email, which Cal.com requires', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
    });
    const hold = await service.hold({ slot_id: slots[1]!.slot_id, idempotency_key: key() });
    const err = await fail(
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: key(),
        user_confirmed: true,
        customer: { first_name: 'Grace', last_name: 'Hopper', phone_number: '+4791234567' },
      }),
    );
    expect(err?.code).toBe('customer_details_required');
    expect(err?.suggested_next_action).toContain('email');
  });

  it('picks up cancellations made in Cal.com', async () => {
    const { service, cal } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
    });
    const hold = await service.hold({
      slot_id: slots[1]!.slot_id,
      idempotency_key: key(),
      customer: CUSTOMER,
    });
    await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    [...cal.bookings.values()][0]!.status = 'cancelled';
    const b = await service.getBooking(hold.booking_id);
    expect(b.status).toBe('cancelled');
    expect(b.cancellation?.reason).toContain('Cal.com');
  });

  it('turns a bad API key into a clear, non-retryable error', async () => {
    const { service } = setup({ apiKey: 'wrong' });
    const err = await fail(
      service.searchAvailability({ date: '2026-10-02', party_size: { total: 1 } }),
    );
    expect(err).toMatchObject({ code: 'provider_error', retryable: false });
    expect(err?.message).toContain('API key');
  });

  it('books one person per appointment', async () => {
    const { service } = setup();
    const err = await fail(
      service.searchAvailability({ date: '2026-10-02', party_size: { total: 2 } }),
    );
    expect(err?.code).toBe('party_size_unsupported');
  });

  it('lists bookings for Studio', async () => {
    const { service } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: '11',
    });
    await service.hold({ slot_id: slots[2]!.slot_id, idempotency_key: key(), customer: CUSTOMER });
    expect(await service.listBookings()).toHaveLength(1);
  });
});
