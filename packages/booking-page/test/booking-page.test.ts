import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, type BookingEvent } from '@openbooking-sh/core';
import {
  MemoryBookingProvider,
  createDemoSalonProvider,
  demoSalonConfig,
} from '@openbooking-sh/provider-memory';
import { createBookingPage } from '../src';

const BASE = 'https://app.example.com/b/studio-nord';
const DATE = '2026-10-16'; // a Friday, more than 24h ahead (free cancellation)

function setup(provider = createDemoSalonProvider()) {
  const clock = new ManualClock('2026-10-08T08:00:00Z');
  const events: BookingEvent[] = [];
  const service = new BookingService({ provider, clock, onEvent: (e) => events.push(e) });
  const page = createBookingPage({
    service,
    pageUrl: BASE,
    apiBase: `${BASE}/book`,
    mcpUrl: 'https://app.example.com/mcp',
    profile: () => ({ category: 'hair_salon', email: 'hei@studionord.example' }),
  });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await page.app.request(path, { headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await page.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { service, page, events, clock, get, post };
}

const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

async function book(t: ReturnType<typeof setup>) {
  const { body } = await t.get(`/api/availability?date=${DATE}&service=haircut&staff=maria`);
  const slot = body.slots[0];
  const hold = await t.post('/api/hold', { slot_id: slot.slot_id, idempotency_key: 'hold-key-1' });
  expect(hold.status).toBe(200);
  const confirm = await t.post('/api/confirm', {
    booking_id: hold.body.booking.booking_id,
    idempotency_key: 'confirm-key-1',
    customer,
    notes: 'Short on the sides',
    user_confirmed: true,
  });
  expect(confirm.status).toBe(200);
  return confirm.body.booking;
}

describe('booking page API', () => {
  it('describes the business', async () => {
    const t = setup();
    const { body } = await t.get('/api/info');
    expect(body.venue.name).toBe('Studio Nord');
    expect(body.services.map((s: any) => s.id)).toEqual(['haircut', 'beard-trim', 'color-cut']);
    expect(body.staff).toEqual([
      { id: 'maria', name: 'Maria' },
      { id: 'jonas', name: 'Jonas' },
      { id: 'aisha', name: 'Aisha' },
    ]);
    expect(body.profile.category).toBe('hair_salon');
  });

  it('narrows availability to one staff member', async () => {
    const t = setup();
    const { status, body } = await t.get(
      `/api/availability?date=${DATE}&service=haircut&staff=jonas`,
    );
    expect(status).toBe(200);
    expect(body.slots.length).toBeGreaterThan(5);
    expect(body.slots.every((s: any) => s.resource.id === 'jonas')).toBe(true);
    expect((await t.get(`/api/availability?date=${DATE}&staff=nobody`)).status).toBe(404);
  });

  it('holds, then confirms with explicit consent, idempotently', async () => {
    const t = setup();
    const { body } = await t.get(`/api/availability?date=${DATE}&service=haircut`);
    const slot = body.slots[0];
    const hold = await t.post('/api/hold', {
      slot_id: slot.slot_id,
      idempotency_key: 'hold-key-1',
    });
    expect(hold.body.booking.status).toBe('held');
    expect(hold.body.booking.expires_at).toBeTruthy();
    const again = await t.post('/api/hold', {
      slot_id: slot.slot_id,
      idempotency_key: 'hold-key-1',
    });
    expect(again.body.booking.booking_id).toBe(hold.body.booking.booking_id);

    const id = hold.body.booking.booking_id;
    const noConsent = await t.post('/api/confirm', {
      booking_id: id,
      idempotency_key: 'confirm-key-1',
      customer,
      user_confirmed: false,
    });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.error.code).toBe('user_confirmation_required');

    const ok = await t.post('/api/confirm', {
      booking_id: id,
      idempotency_key: 'confirm-key-1',
      customer,
      notes: 'First visit',
      user_confirmed: true,
    });
    expect(ok.body.booking.status).toBe('confirmed');
    expect(ok.body.booking.manage_url).toBe(
      `${BASE}/book/manage/${id}?code=${ok.body.booking.confirmation_code}`,
    );
    expect((await t.service.getBooking(id)).notes).toBe('First visit');
  });

  it('releases a hold the visitor no longer wants', async () => {
    const t = setup();
    const { body } = await t.get(`/api/availability?date=${DATE}&service=haircut`);
    const hold = await t.post('/api/hold', {
      slot_id: body.slots[0].slot_id,
      idempotency_key: 'hold-key-2',
    });
    const id = hold.body.booking.booking_id;
    expect((await t.post(`/api/holds/${id}/release`, {})).body.released).toBe(true);
    expect((await t.service.getBooking(id)).status).toBe('cancelled');
  });

  it('shows a booking only with its confirmation code', async () => {
    const t = setup();
    const b = await book(t);
    const ok = await t.get(`/api/bookings/${b.booking_id}?code=${b.confirmation_code}`);
    expect(ok.status).toBe(200);
    expect(ok.body.booking.customer).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });
    expect(ok.body.booking.customer.email).toBeUndefined();
    expect((await t.get(`/api/bookings/${b.booking_id}?code=WRONG1`)).status).toBe(404);
    expect((await t.get(`/api/bookings/${b.booking_id}`)).status).toBe(404);
    expect((await t.get(`/api/bookings/bk_nope?code=${b.confirmation_code}`)).status).toBe(404);
  });

  it('cancels only after the customer confirms the terms', async () => {
    const t = setup();
    const b = await book(t);
    const first = await t.post(`/api/bookings/${b.booking_id}/cancel`, {
      code: b.confirmation_code,
      idempotency_key: 'cancel-key-1',
    });
    expect(first.body.error.code).toBe('user_confirmation_required');
    expect(first.body.error.message).toBe('Cancelling is free.');
    const wrong = await t.post(`/api/bookings/${b.booking_id}/cancel`, {
      code: 'XXXXXX',
      idempotency_key: 'cancel-key-2',
      user_confirmed: true,
    });
    expect(wrong.status).toBe(404);
    const yes = await t.post(`/api/bookings/${b.booking_id}/cancel`, {
      code: b.confirmation_code,
      idempotency_key: 'cancel-key-3',
      user_confirmed: true,
    });
    expect(yes.body.booking.status).toBe('cancelled');
  });

  it('credits the booking page, or a browser agent using WebMCP', async () => {
    const t = setup();
    await t.get(`/api/availability?date=${DATE}`);
    await t.get(`/api/availability?date=${DATE}`, { 'x-openbooking-agent': 'webmcp' });
    const searches = t.events.filter((e) => e.operation === 'search');
    expect(searches.map((e) => e.actor)).toEqual([
      { protocol: 'web', agent: 'Booking page' },
      { protocol: 'web', agent: 'Browser agent' },
    ]);
  });
});

describe('booking page HTML', () => {
  it('escapes business data', async () => {
    const config = demoSalonConfig();
    config.venues[0]!.venue.name = '<script>alert(1)</script>';
    config.venues[0]!.venue.description = '"><img src=x onerror=alert(2)>';
    const t = setup(new MemoryBookingProvider(config));
    const html = await t.page.html();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Injected JSON can't close its script element.
    const data = html.match(
      /<script type="application\/json" id="ob-data">([\s\S]*?)<\/script>/,
    )![1]!;
    expect(data).not.toContain('<');
    expect(JSON.parse(data).venue.name).toBe('<script>alert(1)</script>');
  });

  it('publishes structured data with a ReserveAction', async () => {
    const t = setup();
    const html = await t.page.html();
    const ld = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!,
    );
    expect(ld['@type']).toBe('HairSalon');
    expect(ld.potentialAction['@type']).toBe('ReserveAction');
    expect(ld.potentialAction.target.urlTemplate).toBe(
      `${BASE}?service={service}&date={date}&time={time}`,
    );
    expect(ld.makesOffer[0]).toMatchObject({
      name: 'Haircut',
      price: '650.00',
      priceCurrency: 'NOK',
    });
    expect(html).toContain(`<link rel="canonical" href="${BASE}" />`);
  });

  it('injects valid pre-fill values and drops bad ones', async () => {
    const t = setup();
    const res = await t.page.app.request(
      `/?service=haircut&staff=maria&date=${DATE}&time=15:00&party=1&first_name=Ada&email=nope&phone=%2B4712345678&time_from=x`,
    );
    const html = await res.text();
    const data = JSON.parse(html.match(/id="ob-data">([\s\S]*?)<\/script>/)![1]!);
    expect(data.prefill).toEqual({
      service: 'haircut',
      staff: 'maria',
      date: DATE,
      time: '15:00',
      party: 1,
      first_name: 'Ada',
      phone: '+4712345678',
    });
    expect(data.api_path).toBe('/b/studio-nord/book');
    const bad = await t.page.html({
      service: 'massage',
      staff: 'x',
      date: '2026-13-45',
      time: '25:00',
    });
    expect(JSON.parse(bad.match(/id="ob-data">([\s\S]*?)<\/script>/)![1]!).prefill).toEqual({});
  });

  it('serves a manage page and llms.txt', async () => {
    const t = setup();
    const manage = await t.page.app.request('/manage/bk_123?code=ABC');
    expect(manage.status).toBe(200);
    expect(await manage.text()).toContain('noindex');
    const llms = await (await t.page.app.request('/llms.txt')).text();
    expect(llms).toContain('# Studio Nord');
    expect(llms).toContain('Haircut (id: haircut): 45 min, 650.00 NOK');
    expect(llms).toContain(`${BASE}?service=<service id>&date=YYYY-MM-DD&time=HH:MM`);
    expect(llms).toContain('https://app.example.com/mcp');
  });
});

describe('embed.js (website snippet)', () => {
  /** Just enough DOM to run the snippet: records what it appends and the tools it registers. */
  function fakeBrowser(
    t: ReturnType<typeof setup>,
    attrs: Record<string, string> = {},
    modelContextOn: 'navigator' | 'document' = 'navigator',
  ) {
    const appended: any[] = [];
    const tools: any[] = [];
    const el = (tag: string): any => ({
      tagName: tag.toUpperCase(),
      style: {},
      attrs: {} as Record<string, string>,
      children: [] as any[],
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
      getAttribute(k: string) {
        return this.attrs[k] ?? null;
      },
      appendChild(c: any) {
        this.children.push(c);
      },
      addEventListener() {},
    });
    const document = {
      readyState: 'complete',
      currentScript: { getAttribute: (k: string) => attrs[k.replace(/^data-/, '')] ?? null },
      createElement: el,
      head: { appendChild: (c: any) => appended.push(c) },
      body: { appendChild: (c: any) => appended.push(c) },
      documentElement: { style: {} },
      addEventListener() {},
    };
    // Cross-origin calls from the business's site land on the booking page's API.
    const fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace('/b/studio-nord/book', '');
      return t.page.app.request(path + new URL(url).search, init);
    };
    const modelContext = { registerTool: (tool: any) => tools.push(tool) };
    // WebMCP moved from navigator.modelContext to document.modelContext.
    if (modelContextOn === 'document') (document as any).modelContext = modelContext;
    const navigator = modelContextOn === 'navigator' ? { modelContext } : {};
    return { document, fetch, navigator, appended, tools };
  }

  async function run(
    t: ReturnType<typeof setup>,
    attrs: Record<string, string> = {},
    modelContextOn: 'navigator' | 'document' = 'navigator',
  ) {
    const res = await t.page.app.request('/embed.js');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const code = await res.text();
    const b = fakeBrowser(t, attrs, modelContextOn);
    const window: any = { matchMedia: () => ({ matches: false }) };
    new Function('window', 'document', 'navigator', 'location', 'fetch', 'crypto', code)(
      window,
      b.document,
      b.navigator,
      { origin: 'https://studionord.example' },
      b.fetch,
      globalThis.crypto,
    );
    return { ...b, window, code };
  }

  it('adds a Book button, schema.org data and booking tools to the business site', async () => {
    const t = setup();
    const { appended, tools, window } = await run(t, { label: 'Bestill time' });

    const button = appended.find((e) => e.tagName === 'BUTTON');
    expect(button.textContent).toBe('Bestill time');
    const ld = JSON.parse(appended.find((e) => e.type === 'application/ld+json').text);
    expect(ld).toMatchObject({
      '@type': 'HairSalon',
      name: 'Studio Nord',
      url: 'https://studionord.example/',
    });
    expect(ld.sameAs[0]).toBe(BASE);
    expect(typeof window.OpenBooking.open).toBe('function');
    expect(tools.map((x) => x.name)).toEqual([
      'list_services',
      'search_availability',
      'hold_slot',
      'confirm_booking',
    ]);
  });

  it.each(['document', 'navigator'] as const)(
    'registers the WebMCP tools on %s.modelContext',
    async (where) => {
      const { tools } = await run(setup(), {}, where);
      expect(tools.map((x) => x.name)).toContain('confirm_booking');
    },
  );

  it('books end to end through the WebMCP tools, credited to "Browser agent"', async () => {
    const t = setup();
    const { tools } = await run(t);
    const tool = (name: string) => tools.find((x) => x.name === name);
    const parse = (r: any) => JSON.parse(r.content[0].text);

    const avail = parse(
      await tool('search_availability').execute({ date: DATE, service_id: 'haircut' }),
    );
    const hold = parse(await tool('hold_slot').execute({ slot_id: avail.slots[0].slot_id }));
    const refused = await tool('confirm_booking').execute({
      booking_id: hold.booking.booking_id,
      ...customer,
      user_confirmed: false,
    });
    expect(refused.isError).toBe(true);
    const done = parse(
      await tool('confirm_booking').execute({
        booking_id: hold.booking.booking_id,
        ...customer,
        user_confirmed: true,
      }),
    );
    expect(done.booking.status).toBe('confirmed');
    expect(t.events.find((e) => e.operation === 'confirm' && e.ok)?.actor?.agent).toBe(
      'Browser agent',
    );
  });

  it('respects data-button="none" and data-structured-data="off", and answers CORS preflights', async () => {
    const t = setup();
    const { appended } = await run(t, { button: 'none', 'structured-data': 'off' });
    expect(appended).toEqual([]);
    const pre = await t.page.app.request('/api/hold', {
      method: 'OPTIONS',
      headers: { origin: 'https://studionord.example', 'access-control-request-method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-openbooking-agent');
  });
});
