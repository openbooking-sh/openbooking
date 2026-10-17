/**
 * The API schemas, the OpenAPI document and the real page must say the same thing. Every
 * operation is called for real, and each response is parsed with its schema and must come back
 * unchanged (zod drops unknown keys, so an undocumented field fails here).
 */
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { validate } from '@readme/openapi-parser';
import type * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { api, buildOpenApi, createBookingPage } from '../src';

const BASE = 'https://app.example.com/b/studio-nord';
const DATE = '2026-10-16';
const customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup() {
  const service = new BookingService({
    provider: createDemoSalonProvider(),
    clock: new ManualClock('2026-10-08T08:00:00Z'),
  });
  const page = createBookingPage({
    service,
    pageUrl: BASE,
    apiBase: `${BASE}/book`,
    profile: () => ({ category: 'hair_salon', email: 'hei@studionord.example' }),
  });
  const called = new Set<string>();
  /** One call of one operation; `operationId` is how the OpenAPI document names it. */
  const call = async <S extends z.ZodType>(
    operationId: string,
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
    status = 200,
  ): Promise<z.output<S>> => {
    called.add(operationId);
    const res = await page.app.request(`/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = await res.json();
    expect(res.status, JSON.stringify(json)).toBe(status);
    const parsed = schema.parse(json);
    expect(parsed, 'the schema must describe every field the page sends').toEqual(json);
    return parsed;
  };
  return { page, call, called };
}

describe('the booking page API matches its schemas', () => {
  it('serves every operation as documented', async () => {
    const { call, called, page } = setup();

    await call('getInfo', 'GET', '/info', api.InfoResponseSchema);
    const { slots } = await call(
      'getAvailability',
      'GET',
      `/availability?date=${DATE}&service=haircut&staff=maria`,
      api.AvailabilityResponseSchema,
    );
    const slot = slots[0]!;

    // A hold that is let go again, then a hold that is confirmed.
    const first = await call('hold', 'POST', '/hold', api.HoldResponseSchema, {
      slot_id: slot.slot_id,
      idempotency_key: 'contract-hold-1',
    });
    await call(
      'getHold',
      'GET',
      `/holds/${first.booking.booking_id}`,
      api.HoldDetailResponseSchema,
    );
    const released = await call(
      'releaseHold',
      'POST',
      `/holds/${first.booking.booking_id}/release`,
      api.ReleaseResponseSchema,
    );
    expect(released.released).toBe(true);

    const hold = await call('hold', 'POST', '/hold', api.HoldResponseSchema, {
      slot_id: slot.slot_id,
      idempotency_key: 'contract-hold-2',
    });
    const id = hold.booking.booking_id;
    const confirmed = await call('confirm', 'POST', '/confirm', api.ConfirmResponseSchema, {
      booking_id: id,
      idempotency_key: 'contract-confirm-1',
      user_confirmed: true,
      customer,
      notes: 'Short on the sides',
    });
    const code = confirmed.booking.confirmation_code!;
    // Confirmed: the hold view shows no code and no name.
    const afterwards = await call('getHold', 'GET', `/holds/${id}`, api.HoldDetailResponseSchema);
    expect(afterwards.booking).not.toHaveProperty('confirmation_code');

    await call('getBooking', 'GET', `/bookings/${id}?code=${code}`, api.BookingResponseSchema);
    const cancelled = await call(
      'cancel',
      'POST',
      `/bookings/${id}/cancel`,
      api.BookingResponseSchema,
      { code, idempotency_key: 'contract-cancel-1', user_confirmed: true },
    );
    expect(cancelled.booking.status).toBe('cancelled');

    // Errors carry the documented shape.
    await call(
      'getBooking',
      'GET',
      `/bookings/${id}?code=WRONG`,
      api.ErrorResponseSchema,
      undefined,
      404,
    );
    await call('hold', 'POST', '/hold', api.ErrorResponseSchema, { slot_id: '' }, 400);

    // Nothing in the document is untested, and nothing tested is missing from the document.
    const doc = buildOpenApi({ apiUrl: `${BASE}/book/api` }) as { paths: Record<string, any> };
    const documented = Object.values(doc.paths).flatMap((p) =>
      Object.values(p as Record<string, { operationId: string }>).map((o) => o.operationId),
    );
    expect([...called].sort()).toEqual(documented.sort());
    expect(page.pageUrl).toBe(BASE);
  });
});

describe('the OpenAPI document', () => {
  it('is served by the page, valid OpenAPI 3.1, and points at the API', async () => {
    const { page } = setup();
    const res = await page.app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const doc = (await res.json()) as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: `${BASE}/book/api` }]);
    expect(doc.info.title).toContain('booking API');

    const result = await validate(structuredClone(doc));
    expect(result.valid, JSON.stringify((result as any).errors)).toBe(true);
  });

  it('defines every shared shape once, without the per-schema JSON Schema noise', () => {
    const doc = buildOpenApi({ apiUrl: `${BASE}/book/api` }) as any;
    const text = JSON.stringify(doc);
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Money', 'Booking', 'Slot', 'Error', 'CancellationPolicy']),
    );
    expect(text).not.toContain('"$schema"');
    expect(text).not.toContain('"$id"');
    expect(text).not.toContain('\\d\\d[2468][048]'); // the date-time regex
    // Money is a reference, never inlined.
    expect(doc.components.schemas.Slot.properties.price.anyOf[0]).toEqual({
      $ref: '#/components/schemas/Money',
    });
  });
});
