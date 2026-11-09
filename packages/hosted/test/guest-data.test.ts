/**
 * Guest profiles and dietary notes on a hosted deployment: staff-only, health data handled with
 * care. The sentinel strings below stand for an allergy and a staff note; they must never appear
 * in anything a customer, an AI assistant, an email, a webhook event, analytics, an ops message or
 * a log can see, and must be gone after the visit, on erasure and when the business closes.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ManualClock, MemoryGuestStore, type BookingEvent } from '@openbooking-sh/core';
import { MemoryMailer } from '@openbooking-sh/notifications';
import { guestKey } from '@openbooking-sh/studio';
import { createHostedApp, type HostedOptions } from '../src';

const BASE = 'http://localhost:3000';
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';

const ALLERGY_PAGE = 'ZXQ-sentinel-allergy-via-page';
const ALLERGY_MCP = 'ZXQ-sentinel-allergy-via-mcp';
const STAFF_NOTE = 'ZXQ-sentinel-staff-note';
const SENTINELS = [ALLERGY_PAGE, ALLERGY_MCP, STAFF_NOTE];

const ADA = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const BOB = { first_name: 'Bob', last_name: 'Berg', email: 'bob@example.com' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

function setup(extra: Partial<HostedOptions> = {}) {
  const clock = new ManualClock(NOW);
  const mailer = new MemoryMailer();
  const guests = new MemoryGuestStore();
  const events: Array<[string, BookingEvent]> = [];
  const analytics: unknown[] = [];
  const ops: string[] = [];
  const logs: unknown[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock,
    guests,
    cronSecret: 'a-long-cron-secret',
    mail: { mailer, from: 'bookings@openbooking.sh' },
    onEvent: (id, e) => events.push([id, e]),
    analytics: {
      capture: (...a: unknown[]) => void analytics.push(a),
      flush: async () => undefined,
    },
    ops: { notify: (t: string) => void ops.push(t), flush: async () => undefined },
    ...extra,
  });
  cleanups.push(hosted.close);
  /** Everything an outsider could read: bodies of every response that is not the owner's Studio. */
  const publicBodies: string[] = [];
  const request = async (path: string, init: RequestInit) => {
    const res = await hosted.app.request(`${BASE}${path}`, init);
    if (!path.startsWith('/studio') && !path.startsWith('/api/maintenance')) {
      publicBodies.push(await res.clone().text());
    }
    return res;
  };
  const req = async (
    path: string,
    opts: { method?: string; body?: unknown; token?: string; accept?: string } = {},
  ) => {
    const res = await request(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.accept ? { accept: opts.accept } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  const signup = async (name: string) => {
    const r = await req('/api/signup', {
      body: {
        business_name: name,
        your_name: 'Maria Berg',
        email: `owner-${randomUUID()}@example.com`,
        password: 'correct horse',
        category: 'hair_salon',
        city: 'Oslo',
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as { token: string; business_id: string };
  };
  const mcp = async (path: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('host', new URL(url).host);
        const res = await hosted.app.fetch(new Request(url, { ...init, headers }));
        publicBodies.push(await res.clone().text());
        return res;
      },
    });
    const client = new Client(
      { name: 'claude-ai', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());
    return async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
      return res.structuredContent as Record<string, any>;
    };
  };
  /** Book through the public booking page, with an allergy typed into the form. */
  const bookViaPage = async (
    id: string,
    customer: typeof ADA,
    dietary: string | undefined,
    at: 'first' | 'last' = 'first',
  ) => {
    const api = `/b/${id}/book/api`;
    const av = await req(`${api}/availability?date=${DAY}&service=haircut`);
    const slots = av.json.slots;
    const slot = at === 'first' ? slots[0] : slots[slots.length - 1];
    const hold = await req(`${api}/hold`, {
      body: { slot_id: slot.slot_id, idempotency_key: randomUUID() },
    });
    const bookingId = hold.json.booking.booking_id as string;
    await req(`${api}/holds/${bookingId}`);
    const done = await req(`${api}/confirm`, {
      body: {
        booking_id: bookingId,
        idempotency_key: randomUUID(),
        customer,
        user_confirmed: true,
        ...(dietary ? { dietary_notes: dietary } : {}),
      },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return { bookingId, code: done.json.booking.confirmation_code as string };
  };
  return {
    hosted,
    clock,
    mailer,
    guests,
    events,
    analytics,
    ops,
    logs,
    publicBodies,
    req,
    signup,
    mcp,
    bookViaPage,
  };
}

const everythingIn = (...parts: unknown[]) => JSON.stringify(parts);

describe('dietary notes and staff notes stay off every public surface', () => {
  it('never reach the booking page API, MCP, UCP, A2A, emails, webhook events, analytics, ops messages or logs', async () => {
    const env = setup();
    const { id, token } = await env
      .signup('Studio Nord')
      .then((s) => ({ id: s.business_id, token: s.token }));
    await env.mcp('/mcp'); // the directory endpoint, too

    // 1. Allergy typed on the booking page, and one given by an AI assistant over MCP.
    const page = await env.bookViaPage(id, ADA, ALLERGY_PAGE);
    const call = await env.mcp(`/b/${id}/mcp`);
    const found = await call('search_availability', {
      date: DAY,
      party_size: 1,
      offering_id: 'haircut',
    });
    const hold = await call('hold_slot', {
      slot_id: found.slots[found.slots.length - 1].slot_id,
      idempotency_key: randomUUID(),
      customer: BOB,
      dietary_notes: ALLERGY_MCP,
    });
    await call('confirm_booking', {
      booking_id: hold.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });

    // 2. Staff write a note about Ada in Studio.
    const detail = await env.req(`/studio/api/bookings/${page.bookingId}`, { token });
    expect(detail.json.dietary_note).toBe(ALLERGY_PAGE);
    const key = detail.json.guest.key as string;
    expect(
      (
        await env.req(`/studio/api/guests/${key}`, {
          method: 'PUT',
          token,
          body: { tags: ['regular'], notes: STAFF_NOTE, vip: true },
        })
      ).status,
    ).toBe(200);
    // Staff see everything.
    const briefing = await env.req(`/studio/api/preshift?date=${DAY}`, { token });
    expect(briefing.text).toContain(ALLERGY_PAGE);
    expect(briefing.text).toContain(ALLERGY_MCP);
    expect(briefing.text).toContain(STAFF_NOTE);
    expect(briefing.json).toMatchObject({ bookings: 2, vips: 1, with_dietary_notes: 2 });

    // 3. Read the bookings back on every public surface.
    const base = `/b/${id}`;
    await env.req(`${base}/book/api/bookings/${page.bookingId}?code=${page.code}`);
    await env.req(`${base}/book/api/info`);
    await env.req(`${base}/book/api/openapi.json`);
    await env.req(`${base}/book/llms.txt`);
    await env.req(`${base}`, { accept: 'text/html' });
    await env.req(`${base}/book/manage/${page.bookingId}`, { accept: 'text/html' });
    await env.req(`${base}/ucp/booking-sessions/${page.bookingId}`);
    await env.req(`${base}/ucp/booking-sessions/${hold.booking_id}`);
    await env.req(`${base}/ucp/availability?date=${DAY}&party_size=1`);
    await env.req(`${base}/.well-known/ucp`);
    await call('get_booking', { booking_id: page.bookingId });
    await call('get_booking', { booking_id: hold.booking_id });
    await call('get_business_info', {});
    for (const bookingId of [page.bookingId, hold.booking_id]) {
      const a2a = await env.req(`${base}/a2a`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              messageId: randomUUID(),
              role: 'ROLE_USER',
              parts: [{ data: { skill: 'get_booking', booking_id: bookingId } }],
            },
          },
        },
      });
      expect(a2a.status).toBeLessThan(500);
    }
    await env.req(`${base}/a2a`, {
      body: { jsonrpc: '2.0', id: 2, method: 'SendMessage', params: {} },
    });

    // 4. A cancellation sends its own emails and events.
    await call('cancel_booking', {
      booking_id: hold.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });

    await env.hosted.idle();
    expect(env.publicBodies.length).toBeGreaterThan(15);
    expect(env.mailer.sent.length).toBeGreaterThan(1);
    expect(env.events.length).toBeGreaterThan(3);
    for (const sentinel of SENTINELS) {
      expect(everythingIn(env.publicBodies), `public: ${sentinel}`).not.toContain(sentinel);
      expect(everythingIn(env.mailer.sent), `email: ${sentinel}`).not.toContain(sentinel);
      expect(everythingIn(env.events), `events: ${sentinel}`).not.toContain(sentinel);
      expect(everythingIn(env.analytics), `analytics: ${sentinel}`).not.toContain(sentinel);
      expect(everythingIn(env.ops), `ops: ${sentinel}`).not.toContain(sentinel);
      expect(everythingIn(env.logs), `logs: ${sentinel}`).not.toContain(sentinel);
    }
  });

  it('are removed from the exports and responses that were not meant to carry them', async () => {
    const env = setup();
    const { business_id: id, token } = await env.signup('Studio Nord');
    const page = await env.bookViaPage(id, ADA, ALLERGY_PAGE);
    // The booking itself, as Studio lists it, has no allergy text: it is a separate field.
    const list = await env.req('/studio/api/bookings', { token });
    expect(list.text).not.toContain(ALLERGY_PAGE);
    const detail = await env.req(`/studio/api/bookings/${page.bookingId}`, { token });
    expect(JSON.stringify(detail.json.booking)).not.toContain(ALLERGY_PAGE);
  });
});

describe('retention', () => {
  it('deletes dietary notes the day after the visit, long before personal data is anonymised', async () => {
    const env = setup({ dietaryNoteRetentionDays: 1 });
    const { business_id: id } = await env.signup('Studio Nord');
    const { bookingId } = await env.bookViaPage(id, ADA, ALLERGY_PAGE);
    const tenant = (await env.hosted.tenant(id))!;
    const note = async () => (await env.guests.dietaryNotes(id, [bookingId])).get(bookingId);
    const purge = () => env.req('/api/maintenance/purge', { token: 'a-long-cron-secret' });

    // The visit is on 8 October; same evening and the next day it is still there.
    env.clock.set('2026-10-08T23:00:00Z');
    expect((await purge()).json.dietary_notes_removed).toBe(0);
    expect(await note()).toBe(ALLERGY_PAGE);

    env.clock.set('2026-10-10T08:00:00Z');
    const purged = await purge();
    expect(purged.json.dietary_notes_removed).toBe(1);
    expect(await note()).toBeUndefined();
    // The booking and its customer are still there: only the health data went.
    expect((await tenant.service.getBooking(bookingId)).customer?.first_name).toBe('Ada');
  });

  it('removes a guest profile when the booking details it described are anonymised', async () => {
    const env = setup();
    const { business_id: id, token } = await env.signup('Studio Nord');
    const ada = await env.bookViaPage(id, ADA, undefined);
    const bob = await env.bookViaPage(id, BOB, undefined, 'last');
    const keyOf = async (bookingId: string) =>
      (await env.req(`/studio/api/bookings/${bookingId}`, { token })).json.guest.key as string;
    const [adaKey, bobKey] = [await keyOf(ada.bookingId), await keyOf(bob.bookingId)];
    for (const key of [adaKey, bobKey]) {
      await env.req(`/studio/api/guests/${key}`, {
        method: 'PUT',
        token,
        body: { tags: ['x'], notes: '', vip: false },
      });
    }
    expect((await env.guests.listProfiles(id)).size).toBe(2);

    // Bob books again much later, so he still has details on file after two years.
    env.clock.set('2028-12-01T08:00:00Z');
    const tenant = (await env.hosted.tenant(id))!;
    const { slots } = await tenant.service.searchAvailability({
      date: '2028-12-05',
      party_size: { total: 1 },
      offering_id: 'haircut',
    });
    const hold = await tenant.service.hold({
      slot_id: slots[0]!.slot_id,
      idempotency_key: randomUUID(),
      customer: BOB,
    });
    await tenant.service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });

    const purged = await env.req('/api/maintenance/purge', { token: 'a-long-cron-secret' });
    expect(purged.json.anonymized).toBe(2);
    expect(purged.json.guest_profiles_removed).toBe(1);
    expect([...(await env.guests.listProfiles(id)).keys()]).toEqual([bobKey]);
  });
});

describe('erasure and export', () => {
  it('exports a customer with their profile and allergy note, and erases both', async () => {
    const env = setup();
    const { business_id: id, token } = await env.signup('Studio Nord');
    const ada = await env.bookViaPage(id, ADA, ALLERGY_PAGE);
    const bob = await env.bookViaPage(id, BOB, ALLERGY_MCP, 'last');
    const key = (await env.req(`/studio/api/bookings/${ada.bookingId}`, { token })).json.guest
      .key as string;
    await env.req(`/studio/api/guests/${key}`, {
      method: 'PUT',
      token,
      body: { tags: ['regular'], notes: STAFF_NOTE, vip: true },
    });

    const who = { email: 'ADA@example.com' };
    const exported = await env.req('/studio/api/customers/export', { token, body: who });
    expect(exported.json.guest_profiles).toHaveLength(1);
    expect(exported.json.guest_profiles[0]).toMatchObject({ notes: STAFF_NOTE, vip: true });
    expect(exported.json.dietary_notes).toEqual([
      { booking_id: ada.bookingId, note: ALLERGY_PAGE },
    ]);
    expect(exported.text).not.toContain(ALLERGY_MCP);

    // The upcoming booking keeps its note, but the profile goes at once.
    await env.req('/studio/api/customers/erase', { token, body: who });
    expect((await env.guests.listProfiles(id)).size).toBe(0);
    expect((await env.guests.dietaryNotes(id, [ada.bookingId])).size).toBe(1);

    await env.req(`/studio/api/bookings/${ada.bookingId}/cancel`, { token, body: {} });
    // Cancelling already drops the note; erasing then cleans the booking itself.
    expect((await env.guests.dietaryNotes(id, [ada.bookingId])).size).toBe(0);
    const erased = await env.req('/studio/api/customers/erase', { token, body: who });
    expect(erased.json).toEqual({ anonymized: 1, kept_upcoming: 0 });
    // Bob is untouched.
    expect((await env.guests.dietaryNotes(id, [bob.bookingId])).get(bob.bookingId)).toBe(
      ALLERGY_MCP,
    );
  });

  it('includes guest data in the business export and removes it with the account', async () => {
    const env = setup();
    const { business_id: id, token } = await env.signup('Studio Nord');
    const ada = await env.bookViaPage(id, ADA, ALLERGY_PAGE);
    const key = (await env.req(`/studio/api/bookings/${ada.bookingId}`, { token })).json.guest
      .key as string;
    await env.req(`/studio/api/guests/${key}`, {
      method: 'PUT',
      token,
      body: { tags: [], notes: STAFF_NOTE, vip: false },
    });

    const exported = await env.req('/studio/api/account/export', { token });
    expect(exported.json.guest_profiles[key].notes).toBe(STAFF_NOTE);
    expect(exported.json.dietary_notes[ada.bookingId]).toBe(ALLERGY_PAGE);

    const del = await env.req('/studio/api/account/delete', {
      token,
      body: { password: 'correct horse' },
    });
    expect(del.status).toBe(200);
    expect((await env.guests.listProfiles(id)).size).toBe(0);
    expect((await env.guests.dietaryNotes(id, [ada.bookingId])).size).toBe(0);
  });
});

describe('businesses never see each other', () => {
  it('keeps profiles, keys and notes apart, even for the same guest and the same booking id', async () => {
    const env = setup();
    const a = await env.signup('Alpha Salon');
    const b = await env.signup('Beta Salon');
    const adaA = await env.bookViaPage(a.business_id, ADA, ALLERGY_PAGE);
    const adaB = await env.bookViaPage(b.business_id, ADA, undefined);

    const keyA = (await env.req(`/studio/api/bookings/${adaA.bookingId}`, { token: a.token })).json
      .guest.key as string;
    const keyB = (await env.req(`/studio/api/bookings/${adaB.bookingId}`, { token: b.token })).json
      .guest.key as string;
    // The same email gives a different key in each business, so nothing can link them.
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe(guestKey(a.business_id, ADA));

    await env.req(`/studio/api/guests/${keyA}`, {
      method: 'PUT',
      token: a.token,
      body: { tags: ['vip-a'], notes: STAFF_NOTE, vip: true },
    });

    // Beta cannot read, write or even confirm the existence of Alpha's guest.
    expect((await env.req(`/studio/api/guests/${keyA}`, { token: b.token })).status).toBe(404);
    expect(
      (
        await env.req(`/studio/api/guests/${keyA}`, {
          method: 'PUT',
          token: b.token,
          body: { tags: [], notes: 'x', vip: true },
        })
      ).status,
    ).toBe(404);
    // Beta's view of the same person has no profile, and Alpha's booking is not found.
    expect(
      (await env.req(`/studio/api/guests/${keyB}`, { token: b.token })).json.profile,
    ).toBeNull();
    const peek = await env.req(`/studio/api/bookings/${adaA.bookingId}`, { token: b.token });
    expect(peek.status).toBe(404);
    expect(peek.text).not.toContain(ALLERGY_PAGE);
    const clobber = await env.req(`/studio/api/bookings/${adaA.bookingId}/dietary-note`, {
      method: 'PUT',
      token: b.token,
      body: { dietary_notes: null },
    });
    expect(clobber.status).toBe(404);
    expect(
      (await env.guests.dietaryNotes(a.business_id, [adaA.bookingId])).get(adaA.bookingId),
    ).toBe(ALLERGY_PAGE);

    // Beta's briefing and guest list carry nothing of Alpha's.
    const beta = JSON.stringify([
      (await env.req(`/studio/api/preshift?date=${DAY}`, { token: b.token })).json,
      (await env.req('/studio/api/customers', { token: b.token })).json,
    ]);
    for (const s of [ALLERGY_PAGE, STAFF_NOTE, 'vip-a']) expect(beta).not.toContain(s);

    // Erasing Ada at Beta does not touch her profile at Alpha.
    await env.req(`/studio/api/bookings/${adaB.bookingId}/cancel`, { token: b.token, body: {} });
    await env.req('/studio/api/customers/erase', { token: b.token, body: { email: ADA.email } });
    expect((await env.guests.profiles(a.business_id, [keyA])).size).toBe(1);
  });
});
