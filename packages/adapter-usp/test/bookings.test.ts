import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import {
  buildUspProfile,
  createUspRouter,
  MemoryUspState,
  ProtocolError,
  USP_AUTHORITY,
  type ConsentMode,
  type UspAuthenticator,
} from '../src';
import { problemErrors, profileErrors, responseErrors } from './spec';

// Thursday 1 Oct 2026, 08:00 UTC. Friday 16 Oct is far enough ahead that cancelling is free.
const NOW = '2026-10-01T08:00:00Z';
const FAR = '2026-10-16';
const NEAR = '2026-10-02'; // under 24h away: cancelling costs the late fee

/** Test authenticator: the platform names itself in a header. */
const auth: UspAuthenticator = {
  mechanisms: ['test_header'],
  async authenticate(req) {
    const id = req.headers.get('x-platform');
    if (!id) throw new ProtocolError('authentication_required', 'Name the platform.');
    return { id };
  },
};

const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup(options: { consent?: ConsentMode; withAuth?: boolean; staff?: boolean } = {}) {
  const clock = new ManualClock(NOW);
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const state = new MemoryUspState();
  const consent = options.consent ?? 'action';
  const app = new Hono().route(
    '/usp',
    createUspRouter({
      service,
      baseUrl: 'https://studio.example',
      consent,
      state,
      continueUrl: (b) => `https://studio.example/book/confirm/${b.booking_id}`,
      bookingUrl: (b) =>
        b.confirmation_code
          ? `https://studio.example/book/manage/${b.booking_id}?code=${b.confirmation_code}`
          : undefined,
      ...(options.withAuth === false ? {} : { auth }),
      ...(options.staff
        ? { businessAuth: (r: Request) => r.headers.get('x-staff') === 'yes' }
        : {}),
    }),
  );
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(`/usp${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };
  /** A call as a named platform, with its own Idempotency-Key unless given. */
  const as =
    (platform: string) =>
    (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
      call(method, path, body, { 'x-platform': platform, ...extra });
  return { service, clock, state, call, as, a: as('platform-a'), b: as('platform-b') };
}

type T = ReturnType<typeof setup>;

/** The first free haircut slot on `date`, found through the public API. */
async function slot(t: T, date = FAR, service = 'haircut', resource = 'maria') {
  const res = await t.call('POST', '/availability/query', {
    service_id: service,
    start_date: date,
    end_date: date,
    resource_id: resource,
    limit: 5,
  });
  return res.json.slots[0] as { id: string; start: string };
}

const hold = (t: T, s: { id: string }, extra: Record<string, unknown> = {}) =>
  t.a('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut', ...extra });

const create = (
  t: T,
  s: { id: string },
  extra: Record<string, unknown> = {},
  key: string = crypto.randomUUID(),
) =>
  t.a(
    'POST',
    '/bookings',
    { service_id: 'haircut', slot_id: s.id, buyer: BUYER, ...extra },
    { 'idempotency-key': key },
  );

const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;

describe('profile', () => {
  const business = { name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' };

  it('advertises holds and bookings, with an authorization policy, only when they are served', () => {
    const open = buildUspProfile({ baseUrl: 'https://studio.example', business });
    expect(Object.keys(open.usp.capabilities)).not.toContain('dev.usp-protocol.services.bookings');
    expect('authorization' in open).toBe(false);

    const full = buildUspProfile({
      baseUrl: 'https://studio.example',
      business,
      bookings: { mechanisms: auth.mechanisms },
    });
    expect(profileErrors(full)).toEqual([]);
    expect(full.usp.capabilities['dev.usp-protocol.services.availability']![0]).toMatchObject({
      holds: true,
    });
    expect(full.usp.capabilities['dev.usp-protocol.services.bookings']).toBeDefined();
    expect(full.authorization).toEqual({
      privileged_operations_require_authentication: true,
      accepted_mechanisms: ['test_header'],
    });
  });
});

describe('authentication', () => {
  it('refuses every privileged operation when no authenticator is configured', async () => {
    const t = setup({ withAuth: false, consent: 'commit' });
    const s = await slot(t);
    for (const [method, path, body] of [
      ['POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' }],
      ['POST', '/bookings', { service_id: 'haircut', slot_id: s.id, buyer: BUYER }],
      ['GET', '/bookings/bk_x', undefined],
      ['DELETE', '/availability/holds/hold_bk_x', undefined],
    ] as const) {
      const res = await t.call(method, path, body, { 'x-platform': 'anyone' });
      expect(res.status).toBe(401);
      expect(res.json.type).toBe(type('authentication-required'));
      expect(problemErrors(res.json)).toEqual([]);
    }
    // Public operations stay open.
    expect((await t.call('POST', '/services/list', {})).status).toBe(200);
  });

  it('refuses a caller the authenticator does not know, and does nothing', async () => {
    const t = setup();
    const s = await slot(t);
    const res = await t.call('POST', '/availability/holds', {
      slot_id: s.id,
      service_id: 'haircut',
    });
    expect(res.status).toBe(401);
    // The slot is still free for someone who is authenticated.
    expect((await hold(t, s)).status).toBe(201);
  });

  it('fails closed at construction if consent "action" has nowhere to send the buyer', () => {
    const service = new BookingService({ provider: createDemoSalonProvider() });
    expect(() => createUspRouter({ service, baseUrl: 'https://x.example', auth })).toThrow(
      /continueUrl/,
    );
    expect(() =>
      createUspRouter({ service, baseUrl: 'https://x.example', auth, consent: 'commit' }),
    ).not.toThrow();
  });
});

describe('holds', () => {
  it('reserves a slot with a schema-valid hold that expires', async () => {
    const t = setup();
    const s = await slot(t);
    const res = await hold(t, s);
    expect(res.status).toBe(201);
    expect(responseErrors('/availability/holds', 'post', 201, res.json)).toEqual([]);
    expect(res.json.hold).toMatchObject({
      slot_id: s.id,
      service_id: 'haircut',
      spots: 1,
      status: 'active',
    });
    expect(res.json.hold.id).toMatch(/^hold_/);
    expect(Date.parse(res.json.hold.expires_at)).toBe(Date.parse(NOW) + 10 * 60_000);
  });

  it('gives one of two racing platforms the slot; the other gets a business outcome', async () => {
    const t = setup();
    const s = await slot(t);
    const [x, y] = await Promise.all([
      hold(t, s),
      t.b('POST', '/availability/holds', {
        slot_id: s.id,
        service_id: 'haircut',
      }),
    ]);
    const winners = [x, y].filter((r) => r.status === 201);
    const losers = [x, y].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.json.messages[0]).toMatchObject({
      type: 'error',
      code: 'slot_unavailable',
      severity: 'recoverable',
    });
    expect(losers[0]!.json.hold).toBeUndefined();
  });

  it('stops blocking the slot when the hold lapses', async () => {
    const t = setup();
    const s = await slot(t);
    expect((await hold(t, s)).status).toBe(201);
    t.clock.advance(11 * 60_000);
    const other = await t.b('POST', '/availability/holds', {
      slot_id: s.id,
      service_id: 'haircut',
    });
    expect(other.status).toBe(201);
  });

  it('refuses a slot that is not for the named service, and frees it again', async () => {
    const t = setup();
    const s = await slot(t);
    const wrong = await t.a('POST', '/availability/holds', {
      slot_id: s.id,
      service_id: 'beard-trim',
    });
    expect(wrong.status).toBe(422);
    expect(
      (await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })).status,
    ).toBe(201);
  });

  it('refuses a spots count that does not match the slot, and frees it again', async () => {
    const t = setup();
    const s = await slot(t);
    const res = await hold(t, s, { spots: 3 });
    expect(res.status).toBe(200);
    expect(res.json.messages[0].code).toBe('capacity_exceeded');
    expect(
      (await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })).status,
    ).toBe(201);
  });

  it('releases a hold, idempotently, and only for the platform that made it', async () => {
    const t = setup();
    const s = await slot(t);
    const { json } = await hold(t, s);
    const id = json.hold.id as string;

    const stranger = await t.b('DELETE', `/availability/holds/${id}`);
    expect(stranger.status).toBe(404);
    expect(stranger.json.type).toBe(type('booking-not-found'));

    const released = await t.a('DELETE', `/availability/holds/${id}`);
    expect(released.status).toBe(200);
    expect(released.json.hold.status).toBe('released');
    expect((await t.a('DELETE', `/availability/holds/${id}`)).json.hold.status).toBe('released');
    expect(
      (await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })).status,
    ).toBe(201);
    expect((await t.a('DELETE', '/availability/holds/not-a-hold')).status).toBe(404);
  });

  it('replays an identical retry and rejects a reused key with a different request', async () => {
    const t = setup();
    const s = await slot(t);
    const other = (await slot(t, '2026-10-17'))!;
    const key = { 'idempotency-key': 'hold-key-0001' };
    const first = await t.a(
      'POST',
      '/availability/holds',
      { slot_id: s.id, service_id: 'haircut' },
      key,
    );
    const again = await t.a(
      'POST',
      '/availability/holds',
      { slot_id: s.id, service_id: 'haircut' },
      key,
    );
    expect(again.status).toBe(201);
    expect(again.json.hold.id).toBe(first.json.hold.id);
    const conflict = await t.a(
      'POST',
      '/availability/holds',
      { slot_id: other.id, service_id: 'haircut' },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.type).toBe(type('idempotency-conflict'));
  });
});

describe('creating a booking: consent "action" (the buyer confirms on the business page)', () => {
  it('holds the slot and hands the buyer a link; nothing is booked yet', async () => {
    const t = setup({ consent: 'action' });
    const s = await slot(t);
    const res = await create(t, s);
    expect(res.status).toBe(201);
    expect(responseErrors('/bookings', 'post', 201, res.json)).toEqual([]);
    const booking = res.json.booking;
    expect(booking).toMatchObject({
      service_id: 'haircut',
      service_name: 'Haircut',
      status: 'requires_action',
      confirmation_mode: 'auto',
      party_size: 1,
      buyer: BUYER,
      payment: { status: 'not_required', timing: 'at_service', amount_due: 0 },
    });
    expect(booking.actions).toHaveLength(1);
    expect(booking.actions[0]).toMatchObject({
      type: 'sh.openbooking.confirmation',
      status: 'pending',
      continue_url: `https://studio.example/book/confirm/${booking.id}`,
      expires_at: booking.expires_at,
      message: { code: 'confirmation_required', severity: 'requires_buyer_review' },
    });
    expect(booking.actions[0].continue_url.startsWith('https://')).toBe(true);
    // The engine still only holds it: no confirmation without the buyer.
    expect((await t.service.getBooking(booking.id)).status).toBe('held');
  });

  it('becomes confirmed only when the buyer confirms, and the platform sees it', async () => {
    const t = setup({ consent: 'action' });
    const s = await slot(t);
    const { json } = await create(t, s);
    const id = json.booking.id as string;

    // The person presses the button on the business page: that is the booking page's call.
    await t.service.confirm({
      booking_id: id,
      idempotency_key: 'page-confirm-1',
      user_confirmed: true,
    });

    const read = await t.a('GET', `/bookings/${id}`);
    expect(read.status).toBe(200);
    expect(responseErrors('/bookings/{booking_id}', 'get', 200, read.json)).toEqual([]);
    expect(read.json.booking.status).toBe('confirmed');
    expect(read.json.booking.actions).toBeUndefined();
    expect(read.json.booking.booking_url).toContain(`/book/manage/${id}?code=`);
    expect(read.json.booking['sh.openbooking.cancellation_terms']).toMatchObject({
      allowed: true,
      free: true,
    });
  });

  it('lets an unconfirmed booking lapse as canceled, and frees the slot', async () => {
    const t = setup({ consent: 'action' });
    const s = await slot(t);
    const { json } = await create(t, s);
    t.clock.advance(11 * 60_000);
    const read = await t.a('GET', `/bookings/${json.booking.id}`);
    expect(read.json.booking.status).toBe('canceled');
    expect(read.json.booking.cancellation).toMatchObject({
      reason_code: 'hold_expired',
      canceled_by: 'system',
    });
    expect(
      (await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })).status,
    ).toBe(201);
  });
});

describe('creating a booking: consent "commit" (the platform asked its user)', () => {
  it('confirms immediately', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const res = await create(t, s, { notes: 'Short on the sides' });
    expect(res.status).toBe(201);
    expect(responseErrors('/bookings', 'post', 201, res.json)).toEqual([]);
    expect(res.json.booking).toMatchObject({
      status: 'confirmed',
      notes: 'Short on the sides',
      buyer: BUYER,
    });
    expect(res.json.booking.actions).toBeUndefined();
    expect(res.json.booking.confirmation_mode).toBeUndefined();
    expect((await t.service.getBooking(res.json.booking.id)).status).toBe('confirmed');
  });

  it('advertises rescheduling in the catalog only in this mode', async () => {
    const commit = setup({ consent: 'commit' });
    const action = setup({ consent: 'action' });
    const policy = async (t: T) =>
      (await t.call('GET', '/services/haircut')).json.service.policies.rescheduling.allowed;
    expect(await policy(commit)).toBe(true);
    expect(await policy(action)).toBe(false);
  });
});

describe('creating a booking from a hold', () => {
  it('uses the hold, and a replay returns the same booking', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const h = (await hold(t, s)).json.hold;
    const first = await create(t, s, { hold_id: h.id });
    expect(first.status).toBe(201);
    expect(first.json.booking.id).toBe(h.id.replace('hold_', ''));
    expect(first.json.booking.status).toBe('confirmed');
    // A different Idempotency-Key, same hold: the hold is the natural key (spec 4.2.1).
    const again = await create(t, s, { hold_id: h.id });
    expect(again.status).toBe(201);
    expect(again.json.booking.id).toBe(first.json.booking.id);
    expect((await t.a('DELETE', `/availability/holds/${h.id}`)).json.hold.status).toBe('converted');
  });

  it('says hold_expired when the time is still free, slot_unavailable when it was taken', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const h = (await hold(t, s)).json.hold;
    t.clock.advance(11 * 60_000);
    const free = await create(t, s, { hold_id: h.id });
    expect(free.status).toBe(200);
    expect(free.json.messages[0]).toMatchObject({ code: 'hold_expired', severity: 'recoverable' });

    const h2 = (await hold(t, s)).json.hold;
    t.clock.advance(11 * 60_000);
    expect(
      (await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })).status,
    ).toBe(201);
    const taken = await create(t, s, { hold_id: h2.id });
    expect(taken.json.messages[0].code).toBe('slot_unavailable');
  });

  it("treats an unknown hold, and someone else's, as a validation error", async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const theirs = (
      await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })
    ).json.hold;
    for (const id of ['hold_bk_nope', 'nonsense', theirs.id]) {
      const res = await create(t, s, { hold_id: id });
      expect(res.status).toBe(422);
      expect(res.json.type).toBe(type('validation-error'));
    }
    // Their hold is untouched.
    expect((await t.b('DELETE', `/availability/holds/${theirs.id}`)).json.hold.status).toBe(
      'released',
    );
  });

  it('keeps the hold active when party_size is larger than the hold', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const h = (await hold(t, s)).json.hold;
    const res = await create(t, s, { hold_id: h.id, party_size: 4 });
    expect(res.json.messages[0].code).toBe('capacity_exceeded');
    const retry = await create(t, s, { hold_id: h.id, party_size: 1 });
    expect(retry.status).toBe(201);
  });
});

describe('what a failed create leaves behind', () => {
  it('releases the hold it made when the booking cannot be completed', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    // A bad phone number fails when the buyer is attached; the slot must not stay held.
    const res = await create(t, s, { buyer: { ...BUYER, phone_number: 'x' } });
    expect(res.status).toBe(422);
    expect(
      (await t.b('POST', '/availability/holds', { slot_id: s.id, service_id: 'haircut' })).status,
    ).toBe(201);
  });

  it('does not offer or book a time that needs an online deposit, and leaves nothing held', async () => {
    const t = setup({ consent: 'commit' });
    const { slots } = await t.service.searchAvailability({
      date: FAR,
      party_size: { total: 1 },
      offering_id: 'color-cut',
      limit: 1,
    });
    const deposit = slots[0]!;
    expect(deposit.deposit?.due).toBe('at_confirmation');
    const res = await t.a(
      'POST',
      '/bookings',
      { service_id: 'color-cut', slot_id: deposit.slot_id, buyer: BUYER },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(res.status).toBe(200);
    expect(res.json.messages[0].code).toBe('slot_unavailable');
    expect(res.json.booking).toBeUndefined();
    expect(
      (
        await t.b('POST', '/availability/holds', {
          slot_id: deposit.slot_id,
          service_id: 'color-cut',
        })
      ).status,
    ).toBe(201);
  });
});

describe('idempotency', () => {
  it('books once however many times the same request is sent', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const a = await create(t, s, {}, 'create-key-0001');
    const b = await create(t, s, {}, 'create-key-0001');
    expect(b.status).toBe(201);
    expect(b.json.booking.id).toBe(a.json.booking.id);
    const all = await t.service.listBookings({});
    expect(all.filter((x) => x.status === 'confirmed')).toHaveLength(1);
  });

  it('rejects the same key for a different request with 409', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    await create(t, s, {}, 'create-key-0002');
    const res = await create(t, s, { buyer: { ...BUYER, first_name: 'Grace' } }, 'create-key-0002');
    expect(res.status).toBe(409);
    expect(res.json.type).toBe(type('idempotency-conflict'));
  });

  it('keeps keys private to the platform: another platform never sees a replay', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const mine = await create(t, s, {}, 'shared-key-0001');
    const theirs = await t.b(
      'POST',
      '/bookings',
      { service_id: 'haircut', slot_id: s.id, buyer: BUYER },
      { 'idempotency-key': 'shared-key-0001' },
    );
    // They did not get my booking back; they met a taken slot.
    expect(theirs.json.booking).toBeUndefined();
    expect(theirs.json.messages[0].code).toBe('slot_unavailable');
    expect(mine.status).toBe(201);
  });
});

describe('only the platform that made a booking can use it', () => {
  it('answers 404 to everyone else, and to a hold that never became a booking', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const id = (await create(t, s)).json.booking.id as string;
    for (const [method, path, body] of [
      ['GET', `/bookings/${id}`, undefined],
      ['PUT', `/bookings/${id}`, { notes: 'hi' }],
      ['POST', `/bookings/${id}/cancel`, {}],
      ['POST', `/bookings/${id}/reschedule`, { slot_id: 'x' }],
    ] as const) {
      const res = await t.b(method, path, body);
      expect(res.status).toBe(404);
      expect(res.json.type).toBe(type('booking-not-found'));
    }
    expect((await t.a('GET', `/bookings/${id}`)).status).toBe(200);

    const s2 = await slot(t, '2026-10-17');
    const holdOnly = (await hold(t, s2)).json.hold.id.replace('hold_', '') as string;
    expect((await t.a('GET', `/bookings/${holdOnly}`)).status).toBe(404);
  });

  it('never reads a booking whose buyer has no email (USP requires one)', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    // A booking made another way, for a customer with only a phone number, that this platform
    // somehow owns: USP cannot express it, so it must read as not found, not as a broken booking.
    const held = await t.service.hold({ slot_id: s.id, idempotency_key: 'phone-only-hold' });
    await t.service.confirm({
      booking_id: held.booking_id,
      idempotency_key: 'phone-only-confirm',
      user_confirmed: true,
      customer: { first_name: 'Ola', last_name: 'Nordmann', phone_number: '+4712345678' },
    });
    await t.state.claim(held.booking_id, 'platform-a');
    await t.state.markBooking(held.booking_id);
    const res = await t.a('GET', `/bookings/${held.booking_id}`);
    expect(res.status).toBe(404);
    expect(res.json.type).toBe(type('booking-not-found'));
  });
});

describe('updating a booking', () => {
  it('merges a partial buyer and notes', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const id = (await create(t, s)).json.booking.id as string;
    const res = await t.a('PUT', `/bookings/${id}`, {
      buyer: { first_name: 'Augusta' },
      notes: 'Window seat',
    });
    expect(res.status).toBe(200);
    expect(responseErrors('/bookings/{booking_id}', 'put', 200, res.json)).toEqual([]);
    expect(res.json.booking.buyer).toMatchObject({
      first_name: 'Augusta',
      last_name: 'Lovelace',
      email: 'ada@example.com',
    });
    expect(res.json.booking.notes).toBe('Window seat');
  });

  it('warns that a recipient is not stored instead of dropping it silently', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const res = await create(t, s, { recipient: BUYER });
    expect(res.json.messages[0]).toMatchObject({ type: 'warning', code: 'recipient_not_stored' });
  });

  it('answers a change to a canceled booking with invalid_transition', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const id = (await create(t, s)).json.booking.id as string;
    await t.a('POST', `/bookings/${id}/cancel`, {});
    const res = await t.a('PUT', `/bookings/${id}`, { notes: 'too late' });
    expect(res.status).toBe(200);
    expect(res.json.booking.status).toBe('canceled');
    expect(res.json.messages[0].code).toBe('invalid_transition');
  });
});

describe('cancelling', () => {
  it('releases a booking that is still waiting for its buyer', async () => {
    const t = setup({ consent: 'action' });
    const s = await slot(t);
    const id = (await create(t, s)).json.booking.id as string;
    const res = await t.a('POST', `/bookings/${id}/cancel`, { reason: 'Changed my mind' });
    expect(res.status).toBe(200);
    expect(res.json.booking.status).toBe('canceled');
    expect(res.json.booking.cancellation).toMatchObject({ canceled_by: 'buyer', fee: 0 });
  });

  it('cancels a free cancellation in both modes', async () => {
    for (const consent of ['action', 'commit'] as const) {
      const t = setup({ consent });
      const s = await slot(t);
      const id = (await create(t, s)).json.booking.id as string;
      await t.service.confirm({
        booking_id: id,
        idempotency_key: 'c-1234567',
        user_confirmed: true,
      });
      const res = await t.a('POST', `/bookings/${id}/cancel`, {});
      expect(res.json.booking.status).toBe('canceled');
      expect(res.json.booking.cancellation.fee).toBe(0);
      expect(responseErrors('/bookings/{booking_id}/cancel', 'post', 200, res.json)).toEqual([]);
    }
  });

  it('leaves a fee-bearing cancellation to the customer in "action" mode', async () => {
    const t = setup({ consent: 'action' });
    const s = await slot(t, NEAR);
    const id = (await create(t, s)).json.booking.id as string;
    await t.service.confirm({ booking_id: id, idempotency_key: 'c-1234567', user_confirmed: true });
    const res = await t.a('POST', `/bookings/${id}/cancel`, {});
    expect(res.status).toBe(200);
    expect(res.json.booking.status).toBe('confirmed');
    expect(res.json.messages[0]).toMatchObject({
      code: 'cancellation_not_allowed',
      severity: 'requires_buyer_review',
    });
    expect(res.json.messages[0].content).toContain('325');
    expect(res.json.messages[0].content).toContain(`/book/manage/${id}`);
    expect((await t.service.getBooking(id)).status).toBe('confirmed');
  });

  it('cancels with the fee in "commit" mode, and reports it', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t, NEAR);
    const id = (await create(t, s)).json.booking.id as string;
    const res = await t.a('POST', `/bookings/${id}/cancel`, {});
    expect(res.json.booking.status).toBe('canceled');
    expect(res.json.booking.cancellation.fee).toBe(32500);
  });

  it('tells an agent what cancelling costs before it tries', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t, NEAR);
    const id = (await create(t, s)).json.booking.id as string;
    const terms = (await t.a('GET', `/bookings/${id}`)).json.booking[
      'sh.openbooking.cancellation_terms'
    ];
    expect(terms).toMatchObject({ allowed: true, free: false, fee_now: 32500, currency: 'NOK' });
    expect(terms['sh.openbooking.suggested_next_action']).toMatch(/fee/i);
  });

  it('answers a second cancel with invalid_transition, and a started booking with cancellation_not_allowed', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t, NEAR);
    const id = (await create(t, s)).json.booking.id as string;
    await t.a('POST', `/bookings/${id}/cancel`, {});
    const again = await t.a('POST', `/bookings/${id}/cancel`, {});
    expect(again.json.messages[0].code).toBe('invalid_transition');

    const t2 = setup({ consent: 'commit' });
    const s2 = await slot(t2, NEAR);
    const id2 = (await create(t2, s2)).json.booking.id as string;
    t2.clock.advance(48 * 3600_000);
    const started = await t2.a('POST', `/bookings/${id2}/cancel`, {});
    expect(started.json.messages[0].code).toBe('cancellation_not_allowed');
    expect(started.json.booking.status).toBe('confirmed');
  });
});

describe('rescheduling', () => {
  it('moves a booking in commit mode, keeping its id', async () => {
    const t = setup({ consent: 'commit' });
    const first = await slot(t);
    const id = (await create(t, first)).json.booking.id as string;
    const next = await slot(t, '2026-10-17');
    const res = await t.a('POST', `/bookings/${id}/reschedule`, { slot_id: next.id });
    expect(res.status).toBe(200);
    expect(responseErrors('/bookings/{booking_id}/reschedule', 'post', 200, res.json)).toEqual([]);
    expect(res.json.booking.id).toBe(id);
    expect(res.json.booking.slot.id).toBe(next.id);
    expect(res.json.booking.status).toBe('confirmed');
  });

  it('leaves it to the customer in action mode', async () => {
    const t = setup({ consent: 'action' });
    const first = await slot(t);
    const id = (await create(t, first)).json.booking.id as string;
    await t.service.confirm({ booking_id: id, idempotency_key: 'c-1234567', user_confirmed: true });
    const next = await slot(t, '2026-10-17');
    const res = await t.a('POST', `/bookings/${id}/reschedule`, { slot_id: next.id });
    expect(res.json.booking.slot.id).toBe(first.id);
    expect(res.json.messages[0]).toMatchObject({ code: 'reschedule_not_allowed' });
  });
});

describe('business-only confirm', () => {
  it('is refused for a platform, and for anyone when the business set no staff auth', async () => {
    const t = setup({ consent: 'commit', staff: true });
    const s = await slot(t);
    const id = (await create(t, s)).json.booking.id as string;
    const asPlatform = await t.a('POST', `/bookings/${id}/confirm`, {});
    expect(asPlatform.status).toBe(401);

    const none = setup({ consent: 'commit' });
    const s2 = await slot(none);
    const id2 = (await create(none, s2)).json.booking.id as string;
    expect(
      (await none.call('POST', `/bookings/${id2}/confirm`, {}, { 'x-staff': 'yes' })).status,
    ).toBe(401);
  });

  it('is a no-op on a confirmed booking and invalid_transition on one waiting for its buyer', async () => {
    const t = setup({ consent: 'commit', staff: true });
    const s = await slot(t);
    const id = (await create(t, s)).json.booking.id as string;
    const ok = await t.call('POST', `/bookings/${id}/confirm`, {}, { 'x-staff': 'yes' });
    expect(ok.status).toBe(200);
    expect(ok.json.booking.status).toBe('confirmed');

    const a = setup({ consent: 'action', staff: true });
    const s2 = await slot(a);
    const id2 = (await create(a, s2)).json.booking.id as string;
    const waiting = await a.call('POST', `/bookings/${id2}/confirm`, {}, { 'x-staff': 'yes' });
    expect(waiting.status).toBe(200);
    expect(waiting.json.messages[0].code).toBe('invalid_transition');
    expect((await a.service.getBooking(id2)).status).toBe('held');
  });
});

describe('what errors reveal', () => {
  it('never echoes buyer details', async () => {
    const t = setup({ consent: 'commit' });
    const s = await slot(t);
    const res = await create(t, s, {
      buyer: { first_name: 'Secret', last_name: 'Person', email: 'not-an-email' },
    });
    expect(res.status).toBe(422);
    const text = JSON.stringify(res.json);
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('not-an-email');
  });
});
