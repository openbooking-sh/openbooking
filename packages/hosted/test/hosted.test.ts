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
import {
  PostHogAnalytics,
  SlackNotifier,
  createHostedApp,
  slugify,
  type HostedOptions,
} from '../src';

const BASE = 'http://localhost:3000';
// Tuesday 6 October 2026, 09:00 in Oslo.
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup(extra: Partial<HostedOptions> = {}) {
  const clock = new ManualClock(NOW);
  const mailer = new MemoryMailer();
  const google = createFakeGoogle();
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock,
    mail: { mailer, from: 'bookings@openbooking.sh' },
    google: { clientId: 'cid', clientSecret: 'secret', fetch: google.fetch },
    ...extra,
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

    const index = await req('/b/studio-nord', { accept: 'application/json' });
    expect(index.json.name).toBe('Studio Nord & Co');
    expect((await req('/b/studio-nord')).text).toContain('Studio Nord &amp; Co');
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
        'get_business_info',
        'hold_slot',
        'reschedule_booking',
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
    // The sitemap lists the same businesses as the directory: none until the email is confirmed.
    expect((await req('/sitemap.xml')).text).not.toContain('/b/studio-nord');
    const view = await req('/studio/api/settings', { token });
    expect(view.json.account).toMatchObject({ email_verified: false });

    const resend = await req('/studio/api/account/verify-email', { body: {}, token });
    expect(resend.json).toMatchObject({ ok: true, sent: true });
    expect(mailer.sent.filter((m) => m.subject.startsWith('Confirm'))).toHaveLength(2);

    await confirmEmail('maria@example.com');
    expect(await listed()).toEqual(['studio-nord']);
    const sitemap = await req('/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toContain('xml');
    expect(sitemap.text).toContain(`<loc>${BASE}/b/studio-nord</loc>`);
    expect((await req('/robots.txt')).text).toContain(`Sitemap: ${BASE}/sitemap.xml`);

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
    const signup = (await call('/signup')).text;
    expect(signup).toContain('phc_test');
    // Page views only: Studio shows customer names and notes, sign-up takes a password.
    expect(signup).toContain('autocapture:false');
    expect(signup).toContain('enable_heatmaps:false');
    expect(signup).toContain('disable_session_recording:true');
    expect(signup).toContain('mask_all_text:true');
    // The reset link carries its token in the URL, so that page is never tracked.
    expect((await call('/reset')).text).not.toContain('phc_test');
    // No request to Google Fonts: it would hand every visitor's IP address to Google.
    expect(signup).not.toContain('fonts.googleapis.com');
    await call('/api/signup', {
      business_name: 'Studio Nord',
      your_name: 'Maria',
      email: 'maria@example.com',
      password: 'correct horse',
      category: 'hair_salon',
      city: 'Oslo',
      source: 'hero',
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
    expect(slack[0]).toContain(':tada: New business: *Studio Nord* (hair salon, Oslo) · via hero');
    expect(slack[1]).toBe(':calendar: *Studio Nord* got a booking via Booking page');

    // Neither tool ever sees the owner's or customer's personal details.
    const everything = JSON.stringify(posted);
    for (const pii of ['maria@example.com', 'ada@example.com', 'Lovelace']) {
      expect(everything).not.toContain(pii);
    }
  });
});

describe('business ids', () => {
  it('turns Norwegian and accented names into clean ids', () => {
    expect(slugify('Bjørn & Åse Frisør')).toBe('bjorn-ase-frisor');
    expect(slugify('Café Blåbær')).toBe('cafe-blabaer');
    expect(slugify('!!!')).toBe('business');
  });
});

describe('customer data rights', () => {
  const book = async (
    req: ReturnType<typeof setup>['req'],
    id: string,
    pick: 'first' | 'last',
    customer: Record<string, string>,
    notes: string,
  ) => {
    const api = `/b/${id}/book/api`;
    const av = await req(`${api}/availability?date=${DAY}&service=haircut`);
    const slot = pick === 'first' ? av.json.slots[0] : av.json.slots[av.json.slots.length - 1];
    const hold = await req(`${api}/hold`, {
      body: { slot_id: slot.slot_id, idempotency_key: randomUUID() },
    });
    const done = await req(`${api}/confirm`, {
      body: {
        booking_id: hold.json.booking.booking_id,
        idempotency_key: randomUUID(),
        customer,
        notes,
        user_confirmed: true,
      },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return done.json.booking.booking_id as string;
  };

  it('exports one customer, erases them once their bookings are past or cancelled, keeps the rest', async () => {
    const { req, signup } = setup();
    const { token, business_id } = await signup();
    const bob = { first_name: 'Bob', last_name: 'Berg', email: 'bob@example.com' };
    const adaId = await book(req, business_id, 'first', ada, 'Allergic to latex');
    const bobId = await book(req, business_id, 'last', bob, 'Short on the sides');

    const who = { email: 'ADA@example.com' };
    const exported = await req('/studio/api/customers/export', { token, body: who });
    expect(exported.status).toBe(200);
    expect(exported.json.bookings.map((b: any) => b.booking_id)).toEqual([adaId]);
    expect(exported.json.bookings[0].customer.first_name).toBe('Ada');

    // Her booking is still ahead: kept, and counted, so the business knows who is coming.
    const early = await req('/studio/api/customers/erase', { token, body: who });
    expect(early.json).toEqual({ anonymized: 0, kept_upcoming: 1 });

    const cancelled = await req(`/studio/api/bookings/${adaId}/cancel`, { token, body: {} });
    expect(cancelled.status).toBe(200);
    const erased = await req('/studio/api/customers/erase', { token, body: who });
    expect(erased.json).toEqual({ anonymized: 1, kept_upcoming: 0 });

    const ada1 = await req(`/studio/api/bookings/${adaId}`, { token });
    expect(ada1.json.booking.customer).toBeNull();
    expect(ada1.json.booking.notes).toBeNull();
    expect(ada1.json.booking.status).toBe('cancelled');
    expect(JSON.stringify((await req('/studio/api/bookings', { token })).json)).not.toContain(
      'ada@example.com',
    );
    expect((await req('/studio/api/customers/export', { token, body: who })).json.bookings).toEqual(
      [],
    );
    const bob1 = await req(`/studio/api/bookings/${bobId}`, { token });
    expect(bob1.json.booking.customer.first_name).toBe('Bob');
  });

  it('needs the owner to be logged in, and somebody to look for', async () => {
    const { req, signup } = setup();
    const { token } = await signup();
    expect((await req('/studio/api/customers/erase', { body: { email: 'a@b.co' } })).status).toBe(
      401,
    );
    expect((await req('/studio/api/customers/erase', { token, body: {} })).status).toBe(400);
    expect(
      (await req('/studio/api/customers/erase', { token, body: { phone: '12' } })).status,
    ).toBe(400);
    // The feature is advertised to the Studio page.
    expect((await req('/studio/api/session', { token })).json.data_rights).toBe(true);
  });

  it('removes personal data after the retention period, on a schedule only the cron secret can start', async () => {
    const { hosted, clock, req, signup } = setup({ cronSecret: 's3cret-value' });
    const { business_id } = await signup();
    const bookingId = await book(req, business_id, 'first', ada, 'Allergic to latex');
    const purge = (secret?: string) =>
      req('/api/maintenance/purge', { ...(secret ? { token: secret } : {}) });

    expect((await purge()).status).toBe(401);
    expect((await purge('wrong-secret!')).status).toBe(401);
    const early = await purge('s3cret-value');
    expect(early.status).toBe(200);
    expect(early.json.anonymized).toBe(0);

    // Two years and a bit after the appointment, the customer is no longer in the database.
    clock.set('2028-12-01T08:00:00Z');
    const late = await purge('s3cret-value');
    expect(late.json.anonymized).toBe(1);
    const tenant = await hosted.tenant(business_id);
    const booking = await tenant!.service.getBooking(bookingId);
    expect(booking.customer).toBeNull();
    expect(booking.notes).toBeNull();
    expect(booking.slot.offering.id).toBe('haircut');
  });

  it('lets the owner download everything stored about the business, without secrets', async () => {
    const { req, signup } = setup();
    const { token, business_id } = await signup();
    const bookingId = await book(req, business_id, 'first', ada, 'Allergic to latex');

    const res = await req('/studio/api/account/export', { token });
    expect(res.status).toBe(200);
    expect(res.json.account.business_id).toBe(business_id);
    expect(res.json.settings.profile.name).toBe('Studio Nord');
    expect(res.json.bookings.map((b: any) => b.booking_id)).toEqual([bookingId]);
    expect(res.json.bookings[0].customer.email).toBe('ada@example.com');
    // No password hash, no tokens.
    expect(res.text).not.toMatch(/scrypt\$|password_hash|refresh_token|access_token/);
    expect((await req('/studio/api/account/export')).status).toBe(401);
  });

  it('deletes the account and everything in it, only with the password', async () => {
    const { hosted, req, signup } = setup();
    const email = 'owner-delete@example.com';
    const mine = await signup({ email });
    const other = await signup({ business_name: 'Beta Frisør' });
    await book(req, mine.business_id, 'first', ada, 'Allergic to latex');
    const otherBooking = await book(req, other.business_id, 'last', ada, 'Short on the sides');

    const del = (token: string, body: unknown) =>
      req('/studio/api/account/delete', { token, body });
    // Without the right password nothing happens, and the session survives (403, not 401).
    expect((await del(mine.token, { password: 'wrong password' })).status).toBe(403);
    expect((await del(mine.token, {})).status).toBe(403);
    expect((await req('/studio/api/bookings', { token: mine.token })).json.bookings).toHaveLength(
      1,
    );

    expect((await del(mine.token, { password: 'correct horse' })).status).toBe(200);

    // The account, its booking page and its session are gone ...
    expect(await hosted.businesses.get(mine.business_id)).toBeUndefined();
    expect((await req(`/b/${mine.business_id}`, { accept: 'text/html' })).status).toBe(404);
    expect((await req('/studio/api/bookings', { token: mine.token })).status).toBe(401);
    expect((await req('/api/login', { body: { email, password: 'correct horse' } })).status).toBe(
      401,
    );
    // ... the other business is untouched ...
    const left = await req('/studio/api/bookings', { token: other.token });
    expect(left.json.bookings.map((b: any) => b.booking_id)).toEqual([otherBooking]);
    // ... and signing up again under the same name starts empty: no bookings survived.
    const again = await signup({ email });
    expect(again.business_id).toBe(mine.business_id);
    expect((await req('/studio/api/bookings', { token: again.token })).json.bookings).toEqual([]);
  });

  it('clears expired rate-limit windows, which are keyed by IP address, when it purges', async () => {
    const purge = vi.fn(async () => {});
    const { req } = setup({
      cronSecret: 'a-long-cron-secret',
      rateLimiter: { hit: async () => true, purge },
    });
    expect((await req('/api/maintenance/purge', { token: 'a-long-cron-secret' })).status).toBe(200);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('has no purge endpoint without a cron secret', async () => {
    const { req } = setup();
    expect((await req('/api/maintenance/purge')).status).toBe(404);
  });
});
