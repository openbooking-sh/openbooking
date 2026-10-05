/**
 * Hosted OpenBooking end to end, in-process: sign-up, Studio settings, the per-business endpoints,
 * the OpenBooking app (find_business) with a real MCP client, emails and Google Calendar.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ManualClock } from '@openbooking-sh/core';
import { MemoryMailer } from '@openbooking-sh/notifications';
import { createFakeGoogle } from '../../google-calendar/test/fake-google';
import { PostHogAnalytics, SlackNotifier, createHostedApp } from '../src';

const BASE = 'http://localhost:3000';
// Tuesday 6 October 2026, 09:00 in Oslo.
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const clock = new ManualClock(NOW);
  const mailer = new MemoryMailer();
  const google = createFakeGoogle();
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock,
    mail: { mailer, from: 'bookings@openbooking.sh' },
    google: { clientId: 'cid', clientSecret: 'secret', fetch: google.fetch },
  });
  cleanups.push(hosted.close);
  const req = async (
    path: string,
    opts: { method?: string; body?: unknown; token?: string; accept?: string } = {},
  ) => {
    const res = await hosted.app.request(`${BASE}${path}`, {
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
    return { status: res.status, json, text, headers: res.headers };
  };
  const signup = async (over: Record<string, unknown> = {}) => {
    const r = await req('/api/signup', {
      body: {
        business_name: 'Studio Nord',
        your_name: 'Maria Berg',
        email: `owner-${randomUUID()}@example.com`,
        password: 'correct horse',
        category: 'hair_salon',
        city: 'Oslo',
        ...over,
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as { token: string; business_id: string; booking_page: string };
  };
  /** Click the link in the welcome email, so the business can be listed in the OpenBooking app. */
  const confirmEmail = async (email: string) => {
    await vi.waitFor(() => expect(mailer.sent.some((m) => m.to === email)).toBe(true));
    const mail = mailer.sent.find((m) => m.to === email && m.subject.startsWith('Confirm'))!;
    const url = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    const r = await req(url.pathname + url.search);
    expect(r.headers.get('location')).toContain('verified=yes');
  };
  return { hosted, clock, mailer, google, req, signup, confirmEmail };
}

async function mcp(app: { fetch(r: Request): Response | Promise<Response> }, path: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', new URL(url).host);
      return app.fetch(new Request(url, { ...init, headers }));
    },
  });
  const client = new Client(
    { name: 'claude-ai', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return { ok: !res.isError, data: res.structuredContent as Record<string, any> };
  };
  return { client, call };
}

const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

describe('sign-up and login', () => {
  it('creates a bookable business with starter settings in one call', async () => {
    const { req, signup } = setup();
    const { token, business_id, booking_page } = await signup();
    expect(business_id).toBe('studio-nord');
    expect(booking_page).toBe(`${BASE}/b/studio-nord`);

    const session = await req('/studio/api/session', { token });
    expect(session.status).toBe(200);
    expect(session.json.venues[0].name).toBe('Studio Nord');
    expect(session.json.settings).toBe(true);

    const settings = await req('/studio/api/settings', { token });
    expect(settings.json.settings.staff).toEqual([{ id: 'maria-berg', name: 'Maria Berg' }]);
    expect(settings.json.settings.services.map((s: any) => s.name)).toContain('Haircut');
    expect(settings.json.links[0].url).toBe(`${BASE}/b/studio-nord`);

    const page = await req('/b/studio-nord', { accept: 'text/html' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Studio Nord');
    const avail = await req(`/b/studio-nord/ucp/availability?date=${DAY}&party_size=1`);
    expect(avail.json.offers.length).toBeGreaterThan(0);
  });

  it('keeps ids unique and refuses a second account for the same email', async () => {
    const { req, signup } = setup();
    await signup({ email: 'same@example.com' });
    expect((await signup()).business_id).toBe('studio-nord-2');
    const dup = await req('/api/signup', {
      body: {
        business_name: 'Other',
        your_name: 'X',
        email: 'SAME@example.com',
        password: '12345678',
      },
    });
    expect(dup.status).toBe(409);
    const reserved = await signup({ business_name: 'Studio' });
    expect(reserved.business_id).toBe('studio-2');
  });

  it('logs in with email and password; Studio asks for a password login otherwise', async () => {
    const { req, signup } = setup();
    await signup({ email: 'maria@example.com' });
    const locked = await req('/studio/api/session');
    expect(locked.status).toBe(401);
    expect(locked.json.error).toMatchObject({ login: 'password', login_url: '/api/login' });

    expect(
      (await req('/api/login', { body: { email: 'maria@example.com', password: 'nope' } })).status,
    ).toBe(401);
    const ok = await req('/api/login', {
      body: { email: 'Maria@Example.com', password: 'correct horse' },
    });
    expect(ok.status).toBe(200);
    expect((await req('/studio/api/session', { token: ok.json.token })).status).toBe(200);
    expect((await req('/studio/api/session', { token: ok.json.token + 'x' })).status).toBe(401);
  });
});

describe('Studio settings', () => {
  it('saves settings and the business changes everywhere', async () => {
    const { req, signup } = setup();
    const { token } = await signup();
    const { settings } = (await req('/studio/api/settings', { token })).json;
    settings.profile.name = 'Studio Nord & Co';
    settings.staff.push({ id: 'jonas', name: 'Jonas' });
    settings.services = [
      { id: 'beard', name: 'Beard trim', duration_minutes: 30, price: 35000, staff_ids: ['jonas'] },
    ];
    const saved = await req('/studio/api/settings', { method: 'PUT', body: settings, token });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);

    const index = await req('/b/studio-nord');
    expect(index.json.name).toBe('Studio Nord & Co');
    const avail = await req(`/b/studio-nord/ucp/availability?date=${DAY}&party_size=1`);
    expect(avail.json.offers.length).toBeGreaterThan(0);
    // Only Jonas does beard trims.
    expect(
      avail.json.offers.every(
        (o: any) => o.accommodation_type.title.includes('Jonas') || o.rate_plan.id === 'beard',
      ),
    ).toBe(true);

    const bad = await req('/studio/api/settings', {
      method: 'PUT',
      body: { ...settings, services: [{ ...settings.services[0], staff_ids: ['ghost'] }] },
      token,
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('ghost');
  });
});

describe('the OpenBooking app (find_business)', () => {
  it('finds a business and books it end to end, with emails and Studio attribution', async () => {
    const { hosted, req, signup, mailer, confirmEmail } = setup();
    const salon = await signup({ email: 'maria@example.com' });
    await signup({
      business_name: 'Bart Barbers',
      category: 'barber',
      city: 'Bergen',
      your_name: 'Bart',
      email: 'bart@example.com',
    });
    await confirmEmail('maria@example.com');
    await confirmEmail('bart@example.com');
    const { client, call } = await mcp(hosted.app, '/mcp');

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        'cancel_booking',
        'confirm_booking',
        'find_business',
        'get_booking',
        'hold_slot',
        'search_availability',
      ].sort(),
    );

    const barber = await call('find_business', { query: 'barber' });
    expect(barber.data.businesses.map((b: any) => b.business_id)).toEqual(['bart-barbers']);
    const inOslo = await call('find_business', { query: 'haircut', city: 'oslo' });
    expect(inOslo.data.businesses.map((b: any) => b.business_id)).toEqual(['studio-nord']);

    const missing = await call('search_availability', { date: DAY, party_size: 1 });
    expect(missing.ok).toBe(false);

    const search = await call('search_availability', {
      business_id: 'studio-nord',
      date: DAY,
      party_size: 1,
      offering_id: 'haircut',
      time_from: '14:00',
    });
    expect(search.ok).toBe(true);
    const hold = await call('hold_slot', {
      business_id: 'studio-nord',
      slot_id: search.data.slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer: ada,
    });
    expect(hold.data.status).toBe('held');
    const confirm = await call('confirm_booking', {
      business_id: 'studio-nord',
      booking_id: hold.data.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });
    expect(confirm.data.status).toBe('confirmed');

    // The other business can't see it.
    const elsewhere = await call('get_booking', {
      business_id: 'bart-barbers',
      booking_id: hold.data.booking_id,
    });
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.data.error.code).toBe('not_found');

    await hosted.idle();
    const studio = await req('/studio/api/bookings', { token: salon.token });
    expect(studio.json.bookings).toHaveLength(1);
    expect(studio.json.bookings[0].booked_via).toBe('Claude');

    const toAda = mailer.sent.filter((m) => m.to === 'ada@example.com');
    expect(toAda).toHaveLength(1);
    expect(toAda[0]!.attachments?.[0]?.content).toContain('BEGIN:VCALENDAR');
    expect(toAda[0]!.text).toContain('/b/studio-nord/book/manage/');
    expect(mailer.sent.some((m) => m.subject.startsWith('New booking'))).toBe(true);
  });

  it('hides unlisted and unbookable businesses', async () => {
    const { hosted, req, signup } = setup();
    const { token } = await signup();
    const { settings } = (await req('/studio/api/settings', { token })).json;
    await req('/studio/api/settings', {
      method: 'PUT',
      body: { ...settings, listed: false },
      token,
    });
    const { call } = await mcp(hosted.app, '/mcp');
    expect((await call('find_business', {})).data.businesses).toEqual([]);
    const search = await call('search_availability', {
      business_id: 'studio-nord',
      date: DAY,
      party_size: 1,
    });
    expect(search.data.error.code).toBe('not_found');
  });

  it('keeps bookings and idempotency keys apart between businesses', async () => {
    const { hosted, req, signup } = setup();
    const a = await signup({ business_name: 'Alpha' });
    const b = await signup({ business_name: 'Beta' });
    const key = randomUUID();
    const book = async (id: string) => {
      const { call } = await mcp(hosted.app, `/b/${id}/mcp`);
      const s = await call('search_availability', { date: DAY, party_size: 1 });
      return call('hold_slot', {
        slot_id: s.data.slots[0].slot_id,
        idempotency_key: key,
        customer: ada,
      });
    };
    const ha = await book(a.business_id);
    const hb = await book(b.business_id);
    expect(ha.ok && hb.ok).toBe(true);
    expect(ha.data.booking_id).not.toBe(hb.data.booking_id);

    const listA = await req('/studio/api/bookings', { token: a.token });
    expect(listA.json.bookings.map((x: any) => x.booking_id)).toEqual([ha.data.booking_id]);
    const peek = await req(`/studio/api/bookings/${hb.data.booking_id}`, { token: a.token });
    expect(peek.status).toBe(404);
  });
});

describe('Google Calendar', () => {
  it('connects, blocks busy times and writes bookings to the calendar', async () => {
    const { hosted, req, signup, google } = setup();
    const { token } = await signup();

    const connect = await req('/studio/api/integrations/google/connect', { body: {}, token });
    const url = new URL(connect.json.url);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/google/callback`);
    const state = url.searchParams.get('state')!;

    const forged = await req(`/oauth/google/callback?code=good-code&state=${state}x`);
    expect(forged.headers.get('location')).toContain('google=error');
    const back = await req(
      `/oauth/google/callback?code=good-code&state=${encodeURIComponent(state)}`,
    );
    expect(back.headers.get('location')).toContain('google=connected');

    const view = (await req('/studio/api/settings', { token })).json;
    expect(view.integrations.google).toMatchObject({ connected: true, email: 'owner@example.com' });
    expect(view.integrations.google.calendars.length).toBe(2);

    // Busy 13:00–15:00 Oslo time in the owner's calendar.
    google.addEvent('primary', {
      start: { dateTime: `${DAY}T13:00:00+02:00` },
      end: { dateTime: `${DAY}T15:00:00+02:00` },
    });
    const avail = await req(
      `/b/studio-nord/ucp/availability?date=${DAY}&party_size=1&offering_id=haircut&limit=50`,
    );
    const starts = avail.json.offers.map((o: any) => o.time_slot.start_at.slice(11, 16));
    expect(starts).toContain('12:00');
    expect(starts).not.toContain('13:30');
    expect(starts).toContain('15:00');

    const { call } = await mcp(hosted.app, '/b/studio-nord/mcp');
    const s = await call('search_availability', {
      date: DAY,
      party_size: 1,
      offering_id: 'haircut',
    });
    const h = await call('hold_slot', {
      slot_id: s.data.slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer: ada,
    });
    await call('confirm_booking', {
      booking_id: h.data.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });
    await hosted.idle();
    const ours = google.events.get('primary')!.filter((e) => e.body.extendedProperties);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.body.summary).toContain('Ada Lovelace');

    // Revoked access: Studio says so, and bookings keep working without Google.
    google.revoked = true;
    google.accessToken = 'expired';
    await req(`/b/studio-nord/ucp/availability?date=2026-10-09&party_size=1`);
    await hosted.idle();
    await new Promise((r) => setTimeout(r, 10));
    const after = (await req('/studio/api/settings', { token })).json;
    expect(after.integrations.google.connected).toBe(false);
    expect(after.integrations.google.error).toBeTruthy();

    await req('/studio/api/integrations/google/disconnect', { body: {}, token });
    const off = (await req('/studio/api/settings', { token })).json;
    expect(off.integrations.google).toMatchObject({ connected: false });
    expect(off.integrations.google.error).toBeUndefined();
  });
});

describe('owner accounts', () => {
  const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)![0];

  it('resets a forgotten password by email and logs out old sessions', async () => {
    const { req, signup, mailer } = setup();
    const { token: oldSession } = await signup({ email: 'maria@example.com' });

    const unknown = await req('/api/password/forgot', { body: { email: 'nobody@example.com' } });
    const known = await req('/api/password/forgot', { body: { email: 'Maria@Example.com' } });
    // Same answer either way: the form doesn't reveal who has an account.
    expect(known.json.message).toBe(unknown.json.message);
    const resets = mailer.sent.filter((m) => m.subject.startsWith('Reset'));
    expect(resets.map((m) => m.to)).toEqual(['maria@example.com']);

    const token = decodeURIComponent(new URL(linkIn(resets[0]!.text)).hash.replace('#token=', ''));
    const done = await req('/api/password/reset', { body: { token, password: 'new password 1' } });
    expect(done.status, JSON.stringify(done.json)).toBe(200);

    expect((await req('/studio/api/settings', { token: oldSession })).status).toBe(401);
    const settings = await req('/studio/api/settings', { token: done.json.token });
    expect(settings.json.account).toMatchObject({ email_verified: true });
    const again = await req('/api/password/reset', { body: { token, password: 'other password' } });
    expect(again.json.error.message).toContain('expired or was already used');

    const login = (password: string) =>
      req('/api/login', { body: { email: 'maria@example.com', password } });
    expect((await login('correct horse')).status).toBe(401);
    expect((await login('new password 1')).status).toBe(200);
  });

  it('rate-limits password guessing', async () => {
    const { req, signup } = setup();
    await signup({ email: 'maria@example.com' });
    const login = (password: string) =>
      req('/api/login', { body: { email: 'maria@example.com', password } });
    for (let i = 0; i < 10; i++) expect((await login(`guess-${i}`)).status).toBe(401);
    const blocked = await login('correct horse');
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('rate_limited');
  });

  it('lists a business in the OpenBooking app only after the owner confirms their email', async () => {
    const { hosted, req, signup, mailer, confirmEmail } = setup();
    const { token } = await signup({ email: 'maria@example.com' });
    const { call } = await mcp(hosted.app, '/mcp');
    const listed = async () =>
      (await call('find_business', { query: 'hair' })).data.businesses.map(
        (b: any) => b.business_id,
      );

    expect(await listed()).toEqual([]);
    const view = await req('/studio/api/settings', { token });
    expect(view.json.account).toMatchObject({ email_verified: false });

    const resend = await req('/studio/api/account/verify-email', { body: {}, token });
    expect(resend.json).toMatchObject({ ok: true, sent: true });
    expect(mailer.sent.filter((m) => m.subject.startsWith('Confirm'))).toHaveLength(2);

    await confirmEmail('maria@example.com');
    expect(await listed()).toEqual(['studio-nord']);

    const forged = await req('/api/verify-email?token=not-a-token');
    expect(forged.headers.get('location')).toContain('verified=expired');
  });
});

describe('website snippet', () => {
  it('gives the owner a one-line snippet that serves embed.js for their business', async () => {
    const { req, signup } = setup();
    const { token } = await signup();
    const { json } = await req('/studio/api/settings', { token });
    expect(json.install).toEqual({
      booking_page: `${BASE}/b/studio-nord`,
      snippet: `<script src="${BASE}/b/studio-nord/embed.js" async></script>`,
    });
    const script = await req('/b/studio-nord/embed.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(script.text).toContain(`${BASE}/b/studio-nord/book/api`);
  });
});

describe('self-serve setup', () => {
  it('sends new owners to /setup and imports their website into a proposal', async () => {
    const site = `<html><head><script type="application/ld+json">{"@type":"HairSalon","name":"Studio Nord",
      "telephone":"+4722000001","address":{"streetAddress":"Eksempelgata 12","postalCode":"0550","addressLocality":"Oslo"},
      "openingHours":["Mo-Fr 09:00-18:00","Sa 10:00-15:00"]}</script></head><body></body></html>`;
    const hosted = createHostedApp({
      baseUrl: BASE,
      sessionSecret: 'test-secret-0123456789',
      importer: {
        lookup: async () => ['93.184.216.34'],
        fetch: (async () =>
          new Response(site, { headers: { 'content-type': 'text/html' } })) as typeof fetch,
      },
    });
    cleanups.push(hosted.close);
    const call = async (path: string, body?: unknown, token?: string) => {
      const res = await hosted.app.request(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        text,
        json: text.startsWith('{') ? JSON.parse(text) : undefined,
      };
    };

    expect((await call('/signup')).text).toContain('setupPath');
    const setup = await call('/setup');
    expect(setup.status).toBe(200);
    expect(setup.text).toContain('Set up your booking');

    const { json: account } = await call('/api/signup', {
      business_name: 'Studio Nord',
      your_name: 'Maria',
      email: 'maria@example.com',
      password: 'correct horse',
      category: 'hair_salon',
    });
    expect((await call('/studio/api/import', { url: 'studionord.example' })).status).toBe(401);
    const { status, json } = await call(
      '/studio/api/import',
      { url: 'studionord.example' },
      account.token,
    );
    expect(status).toBe(200);
    expect(json.profile.address).toMatchObject({ street_address: 'Eksempelgata 12' });
    expect(json.opening_hours.sat).toEqual([{ open: '10:00', close: '15:00' }]);
  });
});

describe('analytics and operator notifications', () => {
  it('reports sign-ups and bookings by channel, without customer data', async () => {
    const posted: Array<{ url: string; body: any }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}');
    }) as typeof fetch;
    const hosted = createHostedApp({
      baseUrl: BASE,
      sessionSecret: 'test-secret-0123456789',
      clock: new ManualClock(NOW),
      analytics: new PostHogAnalytics({ apiKey: 'phc_test', fetch: fakeFetch }),
      ops: new SlackNotifier('https://hooks.slack.test/T/B/x', { fetch: fakeFetch }),
      pageAnalytics: { posthogKey: 'phc_test' },
    });
    cleanups.push(hosted.close);
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await hosted.app.request(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        text,
        json: text.startsWith('{') ? JSON.parse(text) : undefined,
      };
    };

    // Owner pages carry the PostHog snippet; customer booking pages don't.
    expect((await call('/signup')).text).toContain('phc_test');
    await call('/api/signup', {
      business_name: 'Studio Nord',
      your_name: 'Maria',
      email: 'maria@example.com',
      password: 'correct horse',
      category: 'hair_salon',
      city: 'Oslo',
    });
    expect((await call('/b/studio-nord', undefined, { accept: 'text/html' })).text).not.toContain(
      'phc_test',
    );

    const api = '/b/studio-nord/book/api';
    const { json: avail } = await call(`${api}/availability?date=${DAY}&service=haircut`);
    const { json: hold } = await call(`${api}/hold`, {
      slot_id: avail.slots[0].slot_id,
      idempotency_key: 'hold-key-analytics',
    });
    const confirmed = await call(`${api}/confirm`, {
      booking_id: hold.booking.booking_id,
      idempotency_key: 'confirm-key-analytics',
      customer: ada,
      user_confirmed: true,
    });
    expect(confirmed.status).toBe(200);
    await hosted.idle();

    const events = posted.filter((p) => p.url.includes('posthog')).map((p) => p.body);
    expect(events.map((e) => e.event)).toEqual([
      'business_signed_up',
      'slot_held',
      'booking_confirmed',
    ]);
    expect(events[2]).toMatchObject({
      distinct_id: 'business:studio-nord',
      properties: { channel: 'Booking page', protocol: 'web', business_id: 'studio-nord' },
    });

    const slack = posted.filter((p) => p.url.includes('slack')).map((p) => p.body.text);
    expect(slack[0]).toContain(':tada: New business: *Studio Nord* (hair salon, Oslo)');
    expect(slack[1]).toBe(':calendar: *Studio Nord* got a booking via Booking page');

    // Neither tool ever sees the owner's or customer's personal details.
    const everything = JSON.stringify(posted);
    for (const pii of ['maria@example.com', 'ada@example.com', 'Lovelace']) {
      expect(everything).not.toContain(pii);
    }
  });
});

describe('visitor pings', () => {
  it('posts one Slack message per visitor, skips bots, and stores nothing', async () => {
    const posted: string[] = [];
    const hosted = createHostedApp({
      baseUrl: BASE,
      sessionSecret: 'test-secret-0123456789',
      ops: new SlackNotifier('https://hooks.slack.test/x', {
        fetch: (async (_u: unknown, init?: RequestInit) => {
          posted.push(JSON.parse(String(init?.body)).text);
          return new Response('ok');
        }) as typeof fetch,
      }),
    });
    cleanups.push(hosted.close);
    const visit = (ip: string, ua = 'Mozilla/5.0 (Macintosh)') =>
      hosted.app.request(`${BASE}/api/visit`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'user-agent': ua,
          'x-real-ip': ip,
          'x-vercel-ip-city': 'Oslo',
          'x-vercel-ip-country': 'NO',
        },
        body: JSON.stringify({ page: '/#pricing', referrer: 'https://www.google.com/search?q=x' }),
      });

    expect((await visit('203.0.113.1')).status).toBe(204);
    await visit('203.0.113.1'); // same visitor again: no second message
    await visit('203.0.113.2', 'Googlebot/2.1');
    await hosted.idle();
    expect(posted).toEqual([':eyes: Visitor on /#pricing · Oslo, NO · via www.google.com']);
  });
});
