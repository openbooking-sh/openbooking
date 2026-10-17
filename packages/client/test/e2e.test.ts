/**
 * The client against a real OpenBooking server over real HTTP: a salon is served on a local
 * port and booked from start to finish.
 */
import { ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp, listen } from '@openbooking-sh/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, OpenBookingError, type OpenBookingClient } from '../src';

const DATE = '2026-10-16'; // a Friday, more than 24 hours ahead: cancelling is free
const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

let server: { port: number; close(): Promise<void> };
let client: OpenBookingClient;

beforeAll(async () => {
  const { app } = createOpenBookingApp({
    provider: createDemoSalonProvider(),
    baseUrl: 'http://localhost:3000',
    serviceOptions: { clock: new ManualClock('2026-10-08T08:00:00Z') },
  });
  server = await listen(app, { port: 0 });
  client = createClient({ baseUrl: `http://127.0.0.1:${server.port}/book` });
});
afterAll(() => server.close());

const fails = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err) => err,
  );
  expect(e).toBeInstanceOf(OpenBookingError);
  return e as OpenBookingError;
};

describe('a booking from start to finish', () => {
  it('reads the business, finds a time, holds it, confirms it and cancels it', async () => {
    const info = await client.info();
    expect(info.venue.timezone).toBe('Europe/Oslo');
    expect(info.services.map((s) => s.id)).toContain('haircut');
    const staff = info.staff[0]!;

    const { slots } = await client.availability({
      date: DATE,
      service: 'haircut',
      staff: staff.id,
    });
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0]!;
    expect(slot.cancellation_policy.description).toBeTruthy();

    const hold = await client.hold({ slot_id: slot.slot_id });
    expect(hold.status).toBe('held');
    expect(hold.expires_at).toBeTruthy();

    // A hold that is let go frees the time again.
    expect(await client.releaseHold(hold.booking_id)).toBe(true);
    const again = await client.hold({ slot_id: slot.slot_id });

    const shown = await client.getHold(again.booking_id);
    expect(shown.status).toBe('held');

    const confirmed = await client.confirm({
      booking_id: again.booking_id,
      user_confirmed: true,
      customer: ada,
      notes: 'Short on the sides',
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmation_code).toBeTruthy();
    expect(confirmed.manage_url).toContain('/manage/');

    // Someone with only the id learns that it is booked, and nothing else.
    const seen = await client.getHold(again.booking_id);
    expect(seen.status).toBe('confirmed');
    expect(seen).not.toHaveProperty('confirmation_code');
    expect(seen).not.toHaveProperty('customer');

    const read = await client.getBooking(again.booking_id, confirmed.confirmation_code!);
    expect(read.customer).toEqual({ first_name: 'Ada', last_name: 'Lovelace' });

    const cancelled = await client.cancel(again.booking_id, {
      code: confirmed.confirmation_code!,
      user_confirmed: true,
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('never books twice when a call is repeated with the same idempotency key', async () => {
    const { slots } = await client.availability({ date: DATE, service: 'haircut' });
    const slot = slots[3]!;
    const first = await client.hold({
      slot_id: slot.slot_id,
      idempotency_key: 'client-e2e-hold-1',
    });
    const retry = await client.hold({
      slot_id: slot.slot_id,
      idempotency_key: 'client-e2e-hold-1',
    });
    expect(retry.booking_id).toBe(first.booking_id);

    const input = {
      booking_id: first.booking_id,
      user_confirmed: true,
      customer: ada,
      idempotency_key: 'client-e2e-confirm-1',
    } as const;
    const one = await client.confirm(input);
    const two = await client.confirm(input);
    expect(two.booking_id).toBe(one.booking_id);
    expect(two.confirmation_code).toBe(one.confirmation_code);
  });
});

describe('what goes wrong', () => {
  it('says a time was just taken, and what to do', async () => {
    const { slots } = await client.availability({ date: DATE, service: 'haircut', staff: 'maria' });
    const slot = slots[5]!;
    await client.hold({ slot_id: slot.slot_id });
    const err = await fails(client.hold({ slot_id: slot.slot_id }));
    expect(err).toMatchObject({ code: 'slot_unavailable', status: 409 });
    expect(err.suggestedNextAction).toBeTruthy();
  });

  it('refuses a wrong confirmation code as not found, and a missing customer', async () => {
    const { slots } = await client.availability({ date: DATE, service: 'haircut', staff: 'maria' });
    const hold = await client.hold({ slot_id: slots[7]!.slot_id });
    expect(await fails(client.getBooking(hold.booking_id, 'WRONG'))).toMatchObject({
      code: 'not_found',
      status: 404,
    });
    const err = await fails(
      client.confirm({ booking_id: hold.booking_id, user_confirmed: true, customer: {} as never }),
    );
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.code).toMatch(/validation_error|customer_details_required/);
  });

  it('reports a server that is not there as a network error', async () => {
    const gone = createClient({ baseUrl: 'http://127.0.0.1:1/book' });
    expect(await fails(gone.info())).toMatchObject({ code: 'network_error', retryable: true });
  });
});
