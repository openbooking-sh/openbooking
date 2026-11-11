import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, runAsActor, type Booking } from '@openbooking-sh/core';
import {
  createDemoRestaurantProvider,
  matchesCustomer,
  type CustomerMatch,
} from '@openbooking-sh/provider-memory';
import { createStudio, guestKey, guestKeys, type DataRightsAdapter } from '../src';
import { STUDIO_HTML } from '../src/ui';

const TOKEN = 'secret-token';
const SENTINEL = 'ZXQ-sentinel-peanut-allergy';
const STAFF_SENTINEL = 'ZXQ-sentinel-staff-note';

function setup() {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({ provider: createDemoRestaurantProvider(), clock });
  const dataRights: DataRightsAdapter = {
    exportCustomer: async (who: CustomerMatch) =>
      (await service.listBookings({ limit: 5000 })).filter((b) => matchesCustomer(b, who)),
    eraseCustomer: async () => ({ anonymized: 0, kept_upcoming: 0 }),
  };
  const studio = createStudio({ service, token: TOKEN, dataRights });
  const call = async (
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ) => {
    const res = await studio.app.request(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(init.token === undefined ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const book = async (
    date: string,
    who: { first: string; email?: string; phone?: string },
    options: { n?: number; dietary?: string; party?: number; time?: string } = {},
  ): Promise<Booking> =>
    runAsActor({ protocol: 'mcp', agent: 'Claude' }, async () => {
      const { slots } = await service.searchAvailability({
        date,
        party_size: { total: options.party ?? 2 },
        offering_id: 'dinner',
      });
      const slot = options.time
        ? slots.find((s) => s.start.includes(options.time!))!
        : slots[options.n ?? 0]!;
      const key = `${who.first}-${date}-${options.n ?? 0}`;
      const hold = await service.hold({
        slot_id: slot.slot_id,
        idempotency_key: `hold-${key}`,
        customer: {
          first_name: who.first,
          last_name: 'Guest',
          ...(who.email ? { email: who.email } : {}),
          ...(who.phone ? { phone_number: who.phone } : {}),
        },
        ...(options.dietary ? { dietary_notes: options.dietary } : {}),
      });
      return service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: `confirm-${key}`,
        user_confirmed: true,
      });
    });
  return { service, studio, call, book, clock };
}

describe('guest keys', () => {
  it('differ for every business and hold no contact detail', () => {
    const a = guestKey('salon-a', { email: 'Ada@Example.com ' });
    const b = guestKey('salon-b', { email: 'ada@example.com' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('ada');
    // Same business, same guest: case and spaces do not matter.
    expect(a).toBe(guestKey('salon-a', { email: 'ada@example.com' }));
  });

  it('fall back to the phone number, by its digits', () => {
    expect(guestKey('a', { phone_number: '+47 123 45 678' })).toBe(
      guestKey('a', { phone_number: '4712345678' }),
    );
    expect(guestKey('a', {})).toBeNull();
    expect(guestKey('a', { phone_number: '12' })).toBeNull();
    expect(guestKeys('a', { email: 'x@y.co', phone_number: '12345678' })).toHaveLength(2);
  });
});

describe('guest profiles', () => {
  it('are edited by staff and shown with the visit history', async () => {
    const { call, book } = setup();
    const booking = await book('2026-10-02', { first: 'Ada', email: 'ada@example.com' });
    const key = guestKey(booking.venue_id, booking.customer)!;

    const before = await call(`/guests/${key}`);
    expect(before.json.profile).toBeNull();
    expect(before.json.history.recent).toHaveLength(1);

    const saved = await call(`/guests/${key}`, {
      method: 'PUT',
      body: { tags: ['window', 'window', ' regular '], notes: STAFF_SENTINEL, vip: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.profile).toMatchObject({ tags: ['window', 'regular'], vip: true });

    const detail = await call(`/bookings/${booking.booking_id}`);
    expect(detail.json.guest.key).toBe(key);
    expect(detail.json.guest.profile.notes).toBe(STAFF_SENTINEL);
    expect(detail.json.guest.history.visits).toBe(0); // the dinner is tomorrow

    const customers = await call('/customers');
    expect(customers.json.customers[0]).toMatchObject({
      guest_key: key,
      vip: true,
      tags: ['window', 'regular'],
    });
    // The list carries no staff note text, only the flags.
    expect(JSON.stringify(customers.json)).not.toContain(STAFF_SENTINEL);

    // Saving an empty profile removes it.
    await call(`/guests/${key}`, { method: 'PUT', body: { tags: [], notes: '', vip: false } });
    expect((await call(`/guests/${key}`)).json.profile).toBeNull();
  });

  it('count visits from the business own confirmed bookings that already happened', async () => {
    const { call, book, clock } = setup();
    const first = await book('2026-10-02', { first: 'Ada', email: 'ada@example.com' });
    await book('2026-10-03', { first: 'Ada', email: 'ada@example.com' });
    const key = guestKey(first.venue_id, first.customer)!;
    clock.set('2026-10-05T08:00:00Z');
    const { json } = await call(`/guests/${key}`);
    expect(json.history.visits).toBe(2);
    expect(json.history.next_visit).toBeNull();
  });

  it('are refused for keys nobody has, bad input and without a token', async () => {
    const { call, book } = setup();
    const booking = await book('2026-10-02', { first: 'Ada', email: 'ada@example.com' });
    const key = guestKey(booking.venue_id, booking.customer)!;
    expect((await call('/guests/' + 'a'.repeat(64))).status).toBe(404);
    expect(
      (
        await call('/guests/' + 'a'.repeat(64), {
          method: 'PUT',
          body: { tags: [], notes: '', vip: true },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/guests/${key}`, {
          method: 'PUT',
          body: { tags: [], notes: 'x'.repeat(2001), vip: false },
        })
      ).status,
    ).toBe(400);
    expect((await call(`/guests/${key}`, { method: 'PUT', body: { vip: 'yes' } })).status).toBe(
      400,
    );
    expect((await call(`/guests/${key}`, { token: 'wrong-token-xx' })).status).toBe(401);
    expect((await call('/preshift', { token: 'wrong-token-xx' })).status).toBe(401);
  });
});

describe('dietary notes in Studio', () => {
  it('show on the booking for staff, and staff can change or clear them', async () => {
    const { call, book } = setup();
    const booking = await book(
      '2026-10-02',
      { first: 'Ada', email: 'ada@example.com' },
      { dietary: SENTINEL },
    );
    const id = booking.booking_id;
    expect((await call(`/bookings/${id}`)).json.dietary_note).toBe(SENTINEL);
    // The booking object itself never carries it.
    expect(JSON.stringify((await call(`/bookings/${id}`)).json.booking)).not.toContain(SENTINEL);
    expect(JSON.stringify((await call('/bookings')).json)).not.toContain(SENTINEL);
    expect(JSON.stringify((await call('/calendar?date=2026-10-02')).json)).not.toContain(SENTINEL);

    const changed = await call(`/bookings/${id}/dietary-note`, {
      method: 'PUT',
      body: { dietary_notes: 'shellfish' },
    });
    expect(changed.json.dietary_note).toBe('shellfish');
    const cleared = await call(`/bookings/${id}/dietary-note`, {
      method: 'PUT',
      body: { dietary_notes: null },
    });
    expect(cleared.json.dietary_note).toBeNull();
    expect(
      (await call(`/bookings/${id}/dietary-note`, { method: 'PUT', body: { dietary_notes: 5 } }))
        .status,
    ).toBe(400);
  });

  it('can be given when staff make a booking by phone', async () => {
    const { call, service } = setup();
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 2 },
      offering_id: 'dinner',
    });
    const made = await call('/bookings', {
      body: {
        slot_id: slots[0]!.slot_id,
        customer: { first_name: 'Bo', last_name: 'Berg', phone_number: '+4712345678' },
        dietary_notes: 'lactose',
      },
    });
    expect(made.status).toBe(200);
    expect((await call(`/bookings/${made.json.booking.booking_id}`)).json.dietary_note).toBe(
      'lactose',
    );
  });
});

describe('pre-shift summary', () => {
  it('counts covers and party sizes, spots VIPs and new versus returning guests, and shows allergies', async () => {
    const { call, book } = setup();
    const ada1 = await book(
      '2026-10-02',
      { first: 'Ada', email: 'ada@example.com' },
      { time: 'T18:' },
    );
    await book(
      '2026-10-03',
      { first: 'Ada', email: 'ada@example.com' },
      { dietary: SENTINEL, party: 4 },
    );
    await book('2026-10-03', { first: 'Bo', email: 'bo@example.com' }, { n: 5, party: 2 });
    const key = guestKey(ada1.venue_id, ada1.customer)!;
    await call(`/guests/${key}`, {
      method: 'PUT',
      body: { tags: ['regular'], notes: STAFF_SENTINEL, vip: true },
    });

    const day = await call('/preshift?date=2026-10-03');
    expect(day.status).toBe(200);
    expect(day.json).toMatchObject({
      date: '2026-10-03',
      bookings: 2,
      covers: 6,
      party_sizes: { '2': 1, '4': 1 },
      vips: 1,
      first_time: 1,
      returning: 1,
      with_dietary_notes: 1,
    });
    const ada = day.json.entries.find((e: any) => e.guest === 'Ada Guest');
    expect(ada).toMatchObject({
      vip: true,
      first_time: false,
      previous_visits: 1,
      dietary_note: SENTINEL,
      staff_notes: STAFF_SENTINEL,
      tags: ['regular'],
    });
    expect(day.json.entries.find((e: any) => e.guest === 'Bo Guest')).toMatchObject({
      first_time: true,
      vip: false,
      dietary_note: null,
    });

    // Another day: the first visit, no allergy.
    const other = await call('/preshift?date=2026-10-02');
    expect(other.json.first_time).toBe(1);
    expect(JSON.stringify(other.json)).not.toContain(SENTINEL);
    expect((await call('/preshift?date=tomorrow')).status).toBe(400);
  });

  it('defaults to today at the venue and handles an empty day', async () => {
    const { call } = setup();
    const { json } = await call('/preshift');
    expect(json).toMatchObject({ date: '2026-10-01', bookings: 0, covers: 0, entries: [] });
  });
});

describe('customer data rights with guest data', () => {
  it('exports the profile and allergy notes with the customer, and erases them (upcoming notes stay)', async () => {
    const { call, book, service, clock } = setup();
    const past = await book(
      '2026-10-02',
      { first: 'Ada', email: 'ada@example.com' },
      { dietary: SENTINEL },
    );
    const later = await book(
      '2026-10-20',
      { first: 'Ada', email: 'ada@example.com' },
      { dietary: 'second-note' },
    );
    const other = await book(
      '2026-10-02',
      { first: 'Bo', email: 'bo@example.com' },
      { n: 3, dietary: 'bo-note' },
    );
    const key = guestKey(past.venue_id, past.customer)!;
    const boKey = guestKey(other.venue_id, other.customer)!;
    await call(`/guests/${key}`, {
      method: 'PUT',
      body: { tags: ['t'], notes: STAFF_SENTINEL, vip: true },
    });
    await call(`/guests/${boKey}`, {
      method: 'PUT',
      body: { tags: [], notes: 'bo staff note', vip: false },
    });

    const exported = await call('/customers/export', { body: { email: 'ADA@example.com' } });
    expect(exported.json.guest_profiles).toHaveLength(1);
    expect(exported.json.guest_profiles[0].notes).toBe(STAFF_SENTINEL);
    expect(exported.json.dietary_notes.map((n: any) => n.note).sort()).toEqual(
      [SENTINEL, 'second-note'].sort(),
    );
    expect(JSON.stringify(exported.json)).not.toContain('bo-note');

    clock.set('2026-10-05T08:00:00Z'); // the first dinner is over, the second still ahead
    const erased = await call('/customers/erase', { body: { email: 'ada@example.com' } });
    expect(erased.status).toBe(200);
    expect(erased.json).toEqual({ anonymized: 0, kept_upcoming: 0 }); // the adapter here is a stub

    const notes = await service.guests.dietaryNotes(past.venue_id, [
      past.booking_id,
      later.booking_id,
      other.booking_id,
    ]);
    expect([...notes.keys()].sort()).toEqual([later.booking_id, other.booking_id].sort());
    expect((await service.guests.profiles(past.venue_id, [key])).size).toBe(0);
    // Somebody else's data is untouched.
    expect((await service.guests.profiles(past.venue_id, [boKey])).size).toBe(1);
  });
});

describe('Studio page', () => {
  it('has the pre-shift view, guest editor and allergy field, and stays template-safe', () => {
    expect(STUDIO_HTML).toContain('id="view-preshift"');
    expect(STUDIO_HTML).toContain('function openGuest');
    expect(STUDIO_HTML).toContain('id="nb-diet"');
    // The client script lives in a template literal: no backticks or dollar-brace inside it.
    const script = STUDIO_HTML.slice(STUDIO_HTML.indexOf('<script'));
    expect(script).not.toContain('`');
    expect(script).not.toContain('${');
  });
});
