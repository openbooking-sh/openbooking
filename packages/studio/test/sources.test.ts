import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, runAsActor, type Actor } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import { bookingsCsv, countBySource, createStudio, sourceDetail, sourceLabel } from '../src';

const CUSTOMER = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  phone_number: '+4791234567',
};

async function salon() {
  const clock = new ManualClock('2026-10-01T06:00:00Z');
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const studio = createStudio({ service, token: 'secret-token' });
  const app = new Hono().route('/studio', studio.app);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/studio${path}`, {
      method,
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    return { status: res.status, json: (await res.json()) as any };
  };
  let n = 0;
  /** Book a haircut at `time` on Oct 2 as `actor` (or with no actor at all). */
  const book = async (
    actor: Actor | undefined,
    time: string,
    staff = 'maria',
    date = '2026-10-02',
  ) => {
    const run = <T>(fn: () => Promise<T>) => (actor ? runAsActor(actor, fn) : fn());
    const { slots } = await service.searchAvailability({
      date,
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: time,
      time_to: time,
      tags: [staff],
    });
    const hold = await run(() =>
      service.hold({ slot_id: slots[0]!.slot_id, idempotency_key: `hold-key-${++n}` }),
    );
    return run(() =>
      service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: `confirm-key-${++n}`,
        user_confirmed: true,
        customer: CUSTOMER,
      }),
    );
  };
  return { service, call, json, book, clock };
}

const CHATGPT: Actor = { protocol: 'mcp', agent: 'ChatGPT', client: 'openai-mcp' };
const GEMINI: Actor = { protocol: 'ucp', agent: 'Gemini', client: 'agent.google.com' };
const WEB: Actor = { protocol: 'web', agent: 'Booking page', client: 'Chrome' };

describe('source names', () => {
  it('names a known assistant, else the channel, else Unknown', () => {
    expect(sourceLabel({ channel: 'mcp', agent: 'openai-mcp' })).toBe('ChatGPT');
    expect(sourceLabel({ channel: 'ucp', agent: 'agent.google.com' })).toBe('Google');
    expect(sourceLabel({ channel: 'mcp', agent: 'homegrown-agent' })).toBe('Other assistant');
    expect(sourceLabel({ channel: 'website', agent: 'Chrome' })).toBe('Website');
    expect(sourceLabel({ channel: 'embed' })).toBe('Website embed');
    expect(sourceLabel({ channel: 'phone' })).toBe('Phone');
    expect(sourceLabel({ channel: 'walk_in' })).toBe('Walk-in');
    expect(sourceLabel(undefined)).toBe('Unknown');
  });

  it('says in the detail that the assistant name is self-reported', () => {
    expect(sourceDetail({ channel: 'mcp', agent: 'claude-ai' })).toBe(
      'Reported by the assistant: claude-ai, via MCP',
    );
    expect(sourceDetail({ channel: 'phone' })).toBe('Booked via a phone call');
    expect(sourceDetail(undefined)).toContain('Not recorded');
  });
});

describe('Studio shows where bookings came from', () => {
  it('lists the source on every booking, and Unknown for old ones', async () => {
    const { json, book } = await salon();
    await book(CHATGPT, '10:00');
    await book(WEB, '11:00');
    await book(undefined, '12:00');

    const list = (await json('GET', '/api/bookings')).json.bookings as any[];
    const byTime = Object.fromEntries(
      list.map((b) => [b.slot.start.slice(11, 16), b.source_label]),
    );
    expect(byTime).toEqual({ '10:00': 'ChatGPT', '11:00': 'Website', '12:00': 'Unknown' });

    const one = (await json('GET', `/api/bookings/${list[0].booking_id}`)).json;
    expect(one.booking.source_label).toBeTruthy();
    expect(one.booking.source_detail).toBeTruthy();
    const old = list.find((b) => b.source_label === 'Unknown');
    expect(old.source).toBeUndefined();
    expect(old.source_detail).toContain('Not recorded');
  });

  it('filters the list by source', async () => {
    const { json, book } = await salon();
    await book(CHATGPT, '10:00');
    await book(CHATGPT, '11:00');
    await book(GEMINI, '12:00');
    await book(undefined, '13:00');

    const names = async (q: string) =>
      ((await json('GET', `/api/bookings${q}`)).json.bookings as any[]).map((b) => b.source_label);
    expect(await names('?source=ChatGPT')).toEqual(['ChatGPT', 'ChatGPT']);
    expect(await names('?source=Google')).toEqual(['Google']);
    expect(await names('?source=Unknown')).toEqual(['Unknown']);
    expect(await names('?source=ChatGPT&status=cancelled')).toEqual([]);
    expect(await names('?source=ChatGPT&limit=1')).toHaveLength(1);
  });

  it('records the source staff pick for a manual booking', async () => {
    const { json } = await salon();
    const avail = (
      await json(
        'GET',
        '/api/availability?date=2026-10-02&party_size=1&offering_id=haircut&time_from=15:00&time_to=17:00',
      )
    ).json;
    const make = (slot: number, source?: string) =>
      json('POST', '/api/bookings', {
        slot_id: avail.slots[slot].slot_id,
        customer: CUSTOMER,
        ...(source ? { source } : {}),
      });

    const phone = await make(0, 'phone');
    expect(phone.json.booking).toMatchObject({
      source: { channel: 'phone' },
      source_label: 'Phone',
    });
    const walkIn = await make(1, 'walk_in');
    expect(walkIn.json.booking.source).toEqual({ channel: 'walk_in' });
    // Nothing chosen: honest "other", not a guess.
    expect((await make(2)).json.booking.source).toEqual({ channel: 'other' });
    // Staff cannot make a manual booking look like an assistant's.
    const bad = await make(0, 'mcp');
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation_error');
  });

  it('counts bookings per source for a date range', async () => {
    const { json, book, clock } = await salon();
    await book(CHATGPT, '10:00');
    await book(CHATGPT, '11:00', 'jonas');
    const cancelled = await book(GEMINI, '12:00');
    await json('POST', `/api/bookings/${cancelled.booking_id}/cancel`, {});
    clock.advance(3 * 86_400_000);
    await book(WEB, '14:00', 'aisha', '2026-10-09');

    const all = (await json('GET', '/api/sources')).json.sources;
    expect(all).toEqual([
      { source: 'ChatGPT', confirmed: 2, cancelled: 0 },
      { source: 'Website', confirmed: 1, cancelled: 0 },
      { source: 'Google', confirmed: 0, cancelled: 1 },
    ]);
    // Created on Oct 1 only, so the website booking of Oct 4 drops out.
    const first = (await json('GET', '/api/sources?from=2026-10-01&to=2026-10-01')).json;
    expect(first.sources.map((s: any) => s.source)).toEqual(['ChatGPT', 'Google']);
    expect((await json('GET', '/api/sources?from=2026-10-04')).json.sources).toEqual([
      { source: 'Website', confirmed: 1, cancelled: 0 },
    ]);
    expect((await json('GET', '/api/sources?from=yesterday')).status).toBe(400);
  });

  it('keeps the source for later steps (cancel in Studio does not rewrite it)', async () => {
    const { json, book } = await salon();
    const b = await book(CHATGPT, '10:00');
    const cancelled = await json('POST', `/api/bookings/${b.booking_id}/cancel`, {});
    expect(cancelled.json.booking).toMatchObject({
      status: 'cancelled',
      source_label: 'ChatGPT',
    });
  });

  it('puts the source controls in the page', async () => {
    const { call } = await salon();
    const page = await (await call('GET', '')).text();
    expect(page).toContain('id="source-filter"');
    expect(page).toContain('id="nb-source"');
    expect(page).toContain('Bookings by source');
    expect(page).toContain('not verified');
  });
});

describe('bookings export', () => {
  it('downloads a CSV with the source and no contact details', async () => {
    const { call, book } = await salon();
    await book(CHATGPT, '10:00');
    await book(undefined, '11:00');

    const res = await call('GET', '/api/export/bookings.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('bookings.csv');
    const csv = await res.text();
    const [head, ...rows] = csv.trim().split('\r\n');
    expect(head).toBe(
      'Date,Time,Customer,Service,With,Guests,Status,Source,Channel,Reported assistant,Booking id',
    );
    expect(rows).toHaveLength(2);
    expect(csv).toContain('Ada Lovelace');
    expect(csv).toContain(',ChatGPT,mcp,openai-mcp,');
    expect(csv).toContain(',Unknown,,,');
    expect(csv).not.toContain('ada@example.com');
    expect(csv).not.toContain('+4791234567');

    const filtered = await (await call('GET', '/api/export/bookings.csv?source=ChatGPT')).text();
    expect(filtered.trim().split('\r\n')).toHaveLength(2);
  });

  it('needs the Studio token', async () => {
    const service = new BookingService({ provider: createDemoSalonProvider() });
    const app = createStudio({ service, token: 'secret-token' }).app;
    expect((await app.request('/api/export/bookings.csv')).status).toBe(401);
  });

  it('defuses spreadsheet formulas in names', () => {
    const booking = {
      booking_id: 'bk_1',
      status: 'confirmed',
      slot: {
        start: '2026-10-02T10:00:00+02:00',
        offering: { name: 'Cut, "quick"' },
        resource: { label: 'Maria' },
        party_size: { total: 1 },
      },
      customer: { first_name: '=HYPERLINK("http://evil")', last_name: 'X' },
    } as never;
    const csv = bookingsCsv([booking], 'Europe/Oslo');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"") X"`);
    expect(csv).toContain('"Cut, ""quick"""');
  });
});

describe('countBySource', () => {
  it('ignores holds that never became bookings', () => {
    const mk = (status: string, source?: object) =>
      ({ status, source, created_at: '2026-10-01T10:00:00Z' }) as never;
    expect(
      countBySource(
        [mk('held', { channel: 'mcp' }), mk('expired'), mk('confirmed', { channel: 'phone' })],
        'UTC',
      ),
    ).toEqual([{ source: 'Phone', confirmed: 1, cancelled: 0 }]);
  });
});
