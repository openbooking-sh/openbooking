import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import {
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import { buildUspProfile, createUspRouter, USP_AUTHORITY } from '../src';
import { parseServiceId } from '../src/mapping';
import { problemErrors, profileErrors, responseErrors, serviceErrors } from './spec';

// Thursday 1 Oct 2026. The salon opens Tue-Fri 09-18 and Sat 10-16 (Europe/Oslo).
const NOW = '2026-10-01T08:00:00Z';

function setup(provider = createDemoSalonProvider()) {
  const service = new BookingService({ provider, clock: new ManualClock(NOW) });
  const app = new Hono().route(
    '/usp',
    createUspRouter({ service, baseUrl: 'https://studio.example' }),
  );
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/usp${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return {
      status: res.status,
      headers: res.headers,
      json: (await res.json()) as any,
    };
  };
  return { call, service };
}

const salon = () => setup();
const restaurant = () => setup(createDemoRestaurantProvider());

describe('USP business profile', () => {
  const profile = buildUspProfile({
    baseUrl: 'https://studio.example/',
    business: { name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
  });

  it('is a valid BusinessProfile', () => {
    expect(profileErrors(profile)).toEqual([]);
  });

  it('advertises only the capabilities that are served', () => {
    expect(Object.keys(profile.usp.capabilities).sort()).toEqual([
      'dev.usp-protocol.services.availability',
      'dev.usp-protocol.services.catalog',
    ]);
    expect(profile.usp.services['dev.usp-protocol.services']![0]).toMatchObject({
      transport: 'rest',
      endpoint: 'https://studio.example/usp',
    });
  });

  it('keeps every spec and schema URL on the namespace authority', () => {
    const urls = JSON.stringify(profile).match(/https:\/\/[^"]+/g)!;
    for (const url of urls.filter((u) => !u.startsWith('https://studio.example'))) {
      expect(url.startsWith(`${USP_AUTHORITY}/`)).toBe(true);
    }
  });
});

describe('USP catalog', () => {
  it('lists services that match the response schema and the Service rules', async () => {
    const { call } = salon();
    const res = await call('POST', '/services/list', {});
    expect(res.status).toBe(200);
    expect(responseErrors('/services/list', 'post', 200, res.json)).toEqual([]);
    expect(res.json.services.map((s: any) => s.id)).toEqual(['haircut', 'beard-trim', 'color-cut']);
    for (const s of res.json.services) expect(serviceErrors(s)).toEqual([]);
    expect(res.json.pagination).toEqual({ cursor: null, has_more: false });
  });

  it('maps an offering faithfully', async () => {
    const { call } = salon();
    const { json } = await call('GET', '/services/haircut');
    expect(json.service).toMatchObject({
      id: 'haircut',
      business_id: 'studio.example',
      name: 'Haircut',
      type: 'appointment',
      duration: { fixed: 'PT45M' },
      pricing: { model: 'per_person', amount: 65000, currency: 'NOK' },
      channel: { type: 'at_business_location' },
      policies: {
        cancellation: { allowed: true },
        confirmation_mode: 'auto',
        requires_payment: true,
        payment_timing: 'at_service',
      },
    });
    // The staff members are offered as choosable resources.
    expect(json.service.resources[0].options.map((o: any) => o.name).sort()).toEqual([
      'Aisha',
      'Jonas',
      'Maria',
    ]);
  });

  it('never calls an unknown price free', async () => {
    const { service } = salon();
    const { toService } = await import('../src');
    const [venue] = await service.listVenues();
    const [offering] = await service.listOfferings();
    const mapped = toService(
      { ...offering!, price_per_person: null },
      { businessId: 'b', multiVenue: false, venue: venue!, resources: [], reschedule: false },
    );
    expect(mapped.pricing).toEqual({ model: 'variable', currency: 'NOK' });
    expect(mapped.policies).toMatchObject({ requires_payment: true, payment_timing: 'at_service' });
    expect(serviceErrors(mapped)).toEqual([]);
  });

  it('declares capacity for table reservations', async () => {
    const { call } = restaurant();
    const { json } = await call('GET', '/services/dinner');
    expect(serviceErrors(json.service)).toEqual([]);
    expect(json.service.type).toBe('reservation');
    expect(json.service.capacity.min).toBeGreaterThanOrEqual(1);
    expect(json.service.capacity.max).toBeGreaterThan(json.service.capacity.min);
  });

  it('filters by type and price, and pages with an opaque cursor', async () => {
    const { call } = salon();
    expect(
      (await call('POST', '/services/list', { filters: { type: 'reservation' } })).json.services,
    ).toEqual([]);
    const cheap = await call('POST', '/services/list', { filters: { price: { max: '40000' } } });
    expect(cheap.json.services.map((s: any) => s.id)).toEqual(['beard-trim']);

    const first = await call('POST', '/services/list', { pagination: { limit: 2 } });
    expect(first.json.services).toHaveLength(2);
    expect(first.json.pagination.has_more).toBe(true);
    const second = await call('POST', '/services/list', {
      pagination: { limit: 2, cursor: first.json.pagination.cursor },
    });
    expect(second.json.services.map((s: any) => s.id)).toEqual(['color-cut']);
    expect(second.json.pagination).toEqual({ cursor: null, has_more: false });

    const bad = await call('POST', '/services/list', { pagination: { cursor: 'nonsense' } });
    expect(bad.status).toBe(400);
    expect(bad.json.type).toBe(`${USP_AUTHORITY}/errors/cursor-expired`);
  });

  it('answers an unknown path id with 404 service_not_found', async () => {
    const { call } = salon();
    const res = await call('GET', '/services/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.json.type).toBe(`${USP_AUTHORITY}/errors/service-not-found`);
    expect(problemErrors(res.json)).toEqual([]);
    expect(res.json['sh.openbooking.suggested_next_action']).toMatch(/services\/list/);
  });

  it('looks up ids: deduplicated, with a warning for each unknown one', async () => {
    const { call } = salon();
    const res = await call('POST', '/services/lookup', {
      ids: ['haircut', 'ghost', 'haircut', 'beard-trim'],
    });
    expect(res.status).toBe(200);
    expect(responseErrors('/services/lookup', 'post', 200, res.json)).toEqual([]);
    expect(res.json.services.map((s: any) => s.id)).toEqual(['haircut', 'beard-trim']);
    expect(res.json.messages).toEqual([
      expect.objectContaining({ code: 'service_unresolved', path: '$.ids[1]' }),
    ]);
  });

  it('accepts 50 ids and rejects more than the limit', async () => {
    const { call } = salon();
    const ids = Array.from({ length: 50 }, (_, i) => `x${i}`);
    expect((await call('POST', '/services/lookup', { ids })).status).toBe(200);
    const tooMany = await call('POST', '/services/lookup', {
      ids: Array.from({ length: 101 }, (_, i) => `x${i}`),
    });
    expect(tooMany.status).toBe(422);
  });

  it('has no feed (501 about:blank), 405 with Allow for wrong methods, and 404 for strangers', async () => {
    const { call } = salon();
    const feed = await call('GET', '/services/feed');
    expect(feed.status).toBe(501);
    expect(feed.json.type).toBe('about:blank');
    expect(problemErrors(feed.json)).toEqual([]);

    const wrong = await call('GET', '/services/list');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await call('POST', '/services/haircut', {})).status).toBe(405);
    expect((await call('GET', '/nothing/here')).status).toBe(404);
  });

  it('rejects a body that is not a JSON object, and never echoes what was sent', async () => {
    const { call } = salon();
    const notJson = await call('POST', '/services/list', '{oops');
    expect(notJson.status).toBe(400);
    expect(notJson.json.type).toBe(`${USP_AUTHORITY}/errors/invalid-request`);

    const wrongType = await call('POST', '/availability/query', {
      service_id: 'secret-value-12345',
      start_date: 'tomorrow-ish',
      end_date: '2026-10-02',
    });
    expect(wrongType.status).toBe(422);
    expect(JSON.stringify(wrongType.json)).not.toContain('secret-value-12345');
    expect(JSON.stringify(wrongType.json)).not.toContain('tomorrow-ish');
  });
});

describe('USP availability', () => {
  type Call = ReturnType<typeof setup>['call'];
  const query = (call: Call, extra: Record<string, unknown> = {}) =>
    call('POST', '/availability/query', {
      service_id: 'haircut',
      start_date: '2026-10-02',
      end_date: '2026-10-02',
      ...extra,
    });
  /** Every slot across all pages (a page holds at most 100). */
  const allSlots = async (call: Call, extra: Record<string, unknown> = {}) => {
    const slots: any[] = [];
    let cursor: string | undefined;
    do {
      const { json } = await query(call, { ...extra, ...(cursor ? { cursor } : {}) });
      slots.push(...json.slots);
      cursor = json.pagination?.has_more ? json.pagination.cursor : undefined;
    } while (cursor);
    return slots;
  };

  it('returns schema-valid slots with both time zone fields and opening hours', async () => {
    const { call } = salon();
    const res = await query(call);
    expect(res.status).toBe(200);
    expect(responseErrors('/availability/query', 'post', 200, res.json)).toEqual([]);
    expect(res.json).toMatchObject({
      service_id: 'haircut',
      applied_date_bounds_timezone: 'Europe/Oslo',
      business_timezone: 'Europe/Oslo',
    });
    expect(res.json.slots.length).toBeGreaterThan(0);
    expect(res.json.opening_hours).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day_of_week: expect.arrayContaining(['tuesday', 'friday']) }),
      ]),
    );
    const starts = res.json.slots.map((s: any) => Date.parse(s.start));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(res.json.slots[0]).toMatchObject({
      service_id: 'haircut',
      duration: 'PT45M',
      state: 'available',
      location: { id: 'studio-nord', name: 'Studio Nord' },
    });
  });

  it('returns one slot per stylist at the same time', async () => {
    const { call } = salon();
    const { json } = await query(call);
    const at9 = json.slots.filter((s: any) => s.start.startsWith('2026-10-02T09:00'));
    expect(at9.map((s: any) => s.resources[0].name).sort()).toEqual(['Aisha', 'Jonas', 'Maria']);
    expect(new Set(at9.map((s: any) => s.id)).size).toBe(3);
  });

  it('narrows to one resource when asked', async () => {
    const { call } = salon();
    const { json } = await query(call, { resource_id: 'maria' });
    expect(json.slots.length).toBeGreaterThan(0);
    for (const s of json.slots) expect(s.resources[0].name).toBe('Maria');
  });

  it('reads date-only bounds on the requested calendar, and date-times as exact instants', async () => {
    const { call } = salon();
    const oslo = await allSlots(call);
    const tokyo = await allSlots(call, { date_bounds_timezone: 'Asia/Tokyo' });
    const tokyoRes = await query(call, { date_bounds_timezone: 'Asia/Tokyo' });
    expect(tokyoRes.json.applied_date_bounds_timezone).toBe('Asia/Tokyo');
    expect(tokyoRes.json.business_timezone).toBe('Europe/Oslo');
    // Tokyo's 2 Oct runs from 1 Oct 17:00 to 2 Oct 17:00 in Oslo: it picks up Thursday evening
    // and drops the end of Friday. (The counts happen to match, so compare the slots themselves.)
    const startsOn = (slots: any[], day: string) => slots.filter((s) => s.start.startsWith(day));
    expect(startsOn(oslo, '2026-10-01')).toEqual([]);
    expect(startsOn(tokyo, '2026-10-01').length).toBeGreaterThan(0);
    for (const s of tokyo) {
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse('2026-10-01T15:00:00Z'));
      expect(Date.parse(s.start)).toBeLessThan(Date.parse('2026-10-02T15:00:00Z'));
    }
    expect(oslo.some((s) => Date.parse(s.start) >= Date.parse('2026-10-02T15:00:00Z'))).toBe(true);
    expect(tokyo.some((s) => Date.parse(s.start) >= Date.parse('2026-10-02T15:00:00Z'))).toBe(
      false,
    );

    // Date-time bounds are instants: date_bounds_timezone must not change them.
    const window = {
      start_date: '2026-10-02T12:00:00+02:00',
      end_date: '2026-10-02T14:00:00+02:00',
    };
    const a = await query(call, window);
    const b = await query(call, { ...window, date_bounds_timezone: 'Asia/Tokyo' });
    expect(a.json.slots.map((s: any) => s.id)).toEqual(b.json.slots.map((s: any) => s.id));
    expect(a.json.slots.length).toBeGreaterThan(0);
    for (const s of a.json.slots) {
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse('2026-10-02T10:00:00Z'));
      expect(Date.parse(s.start)).toBeLessThan(Date.parse('2026-10-02T12:00:00Z'));
    }
  });

  it('covers a multi-day range in order', async () => {
    const { call } = salon();
    const slots = await allSlots(call, { end_date: '2026-10-03' });
    const days = new Set(slots.map((s: any) => s.start.slice(0, 10)));
    expect([...days]).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('rejects a range wider than the limit with 400 range_too_wide', async () => {
    const { call } = salon();
    const res = await query(call, { end_date: '2026-10-10' });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe(`${USP_AUTHORITY}/errors/range-too-wide`);
    // Exactly seven days is still fine.
    expect((await query(call, { end_date: '2026-10-08' })).status).toBe(200);
  });

  it('answers bad input with validation_error', async () => {
    const { call } = salon();
    const zone = await query(call, { date_bounds_timezone: 'Mars/Olympus' });
    expect(zone.status).toBe(422);
    const reversed = await query(call, { start_date: '2026-10-03', end_date: '2026-10-02' });
    expect(reversed.status).toBe(422);
    const unknown = await query(call, { service_id: 'ghost' });
    // The id is in the body, so it is a validation problem and not a 404.
    expect(unknown.status).toBe(422);
    expect(unknown.json.type).toBe(`${USP_AUTHORITY}/errors/validation-error`);
  });

  it('pages slots with a cursor', async () => {
    const { call } = salon();
    const all = (await allSlots(call)).map((s: any) => s.id);
    const first = await query(call, { limit: 5 });
    expect(first.json.slots).toHaveLength(5);
    expect(first.json.pagination.has_more).toBe(true);
    const second = await query(call, { limit: 5, cursor: first.json.pagination.cursor });
    expect(second.json.slots.map((s: any) => s.id)).toEqual(all.slice(5, 10));
  });

  it('does not offer slots that need an online deposit, and says so', async () => {
    const { call } = salon();
    const res = await call('POST', '/availability/query', {
      service_id: 'color-cut',
      start_date: '2026-10-02',
      end_date: '2026-10-02',
    });
    expect(res.status).toBe(200);
    expect(res.json.slots).toEqual([]);
    expect(res.json.messages).toEqual([expect.objectContaining({ code: 'slots_omitted' })]);
  });

  it('turns a party the venue cannot seat into a capacity_exceeded message, not an error', async () => {
    const { call } = salon();
    const res = await query(call, { party_size: 4 });
    expect(res.status).toBe(200);
    expect(res.json.slots).toEqual([]);
    expect(res.json.messages).toEqual([expect.objectContaining({ code: 'capacity_exceeded' })]);
  });

  it('serves restaurant tables for a party', async () => {
    const { call } = restaurant();
    const res = await call('POST', '/availability/query', {
      service_id: 'dinner',
      start_date: '2026-10-02',
      end_date: '2026-10-02',
      party_size: 2,
    });
    expect(res.status).toBe(200);
    expect(responseErrors('/availability/query', 'post', 200, res.json)).toEqual([]);
    expect(res.json.slots.length).toBeGreaterThan(0);
    expect(res.json.slots[0].resources[0].type).toBe('table');
  });
});

describe('service ids', () => {
  const venue = (id: string) => ({ id, name: id, timezone: 'Europe/Oslo' });

  it('stay as the offering id with one venue and carry the venue with several', () => {
    expect(parseServiceId('haircut', [venue('a')])).toEqual({
      venueId: 'a',
      offeringId: 'haircut',
    });
    expect(parseServiceId('b:haircut', [venue('a'), venue('b')])).toEqual({
      venueId: 'b',
      offeringId: 'haircut',
    });
    expect(parseServiceId('haircut', [venue('a'), venue('b')])).toBeNull();
  });
});
