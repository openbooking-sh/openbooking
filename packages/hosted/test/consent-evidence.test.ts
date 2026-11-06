/**
 * The Studio's agent log is the audit trail: for each booking an agent confirmed or cancelled it
 * must show what the user was told and agreed to, without the customer's name or contact details.
 */
import { afterEach, expect, it } from 'vitest';
import { ManualClock } from '@openbooking-sh/core';
import { MemoryBusinessStore, createHostedApp } from '../src';

const BASE = 'http://localhost:3000';
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it('records what the user approved when a booking is confirmed and cancelled', async () => {
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock: new ManualClock(NOW),
    businesses: new MemoryBusinessStore(),
  });
  cleanups.push(hosted.close);
  const req = async (
    path: string,
    opts: { body?: unknown; token?: string; accept?: string } = {},
  ) => {
    const res = await hosted.app.request(`${BASE}${path}`, {
      method: opts.body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as any };
  };

  const signup = await req('/api/signup', {
    body: {
      business_name: 'Studio Nord',
      your_name: 'Maria Berg',
      email: 'owner@example.com',
      password: 'correct horse',
      category: 'hair_salon',
      city: 'Oslo',
    },
  });
  expect(signup.status, signup.text).toBe(200);
  const token = signup.json.token as string;

  const info = await req('/b/studio-nord/book/api/info');
  const slots = await req(
    `/b/studio-nord/book/api/availability?date=${DAY}&service=${info.json.services[0].id}`,
  );
  const held = await req('/b/studio-nord/book/api/hold', {
    body: { slot_id: slots.json.slots[0].slot_id, idempotency_key: 'hold-key-0001' },
  });
  expect(held.status, held.text).toBe(200);
  const id = held.json.booking.booking_id as string;

  const confirmed = await req('/b/studio-nord/book/api/confirm', {
    body: {
      booking_id: id,
      idempotency_key: 'confirm-key-0001',
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      user_confirmed: true,
    },
  });
  expect(confirmed.status, confirmed.text).toBe(200);
  const cancelled = await req(`/b/studio-nord/book/api/bookings/${id}/cancel`, {
    body: {
      code: confirmed.json.booking.confirmation_code,
      idempotency_key: 'cancel-key-0001',
      user_confirmed: true,
    },
  });
  expect(cancelled.status, cancelled.text).toBe(200);
  await hosted.idle();

  const log = await req('/studio/api/activity?limit=50', { token });
  expect(log.status, log.text).toBe(200);
  const entries = log.json.activity as any[];
  const confirm = entries.find((e) => e.operation === 'confirm' && e.ok);
  const cancel = entries.find((e) => e.operation === 'cancel' && e.ok);

  expect(confirm.consent).toMatchObject({
    user_confirmed: true,
    terms: {
      offering: info.json.services[0].name,
      cancellation_policy: { description: expect.any(String) },
    },
  });
  expect(confirm.consent.terms.start).toBe(held.json.booking.start);
  expect(cancel.consent).toMatchObject({ user_confirmed: true, fee: null });
  // Holds need no consent, and nothing in the log names the customer.
  expect(entries.find((e) => e.operation === 'hold').consent).toBeUndefined();
  expect(JSON.stringify(entries)).not.toMatch(/Ada|Lovelace|ada@example\.com/);
});
