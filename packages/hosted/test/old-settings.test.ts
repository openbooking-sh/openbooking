/**
 * Businesses are stored as JSON and read back without being re-validated, so a business saved
 * before a settings block existed comes back without it. Each block added since launch has to
 * survive that: the booking page, the catalog, Studio, the OpenBooking app and a re-save must
 * all work for a business saved under every earlier shape.
 *
 * The shapes, oldest first (what `BusinessSettingsSchema` produced at the time):
 *  - `launch`: commit 502a5ee. No `payments`, no `assistants`.
 *  - `payments`: commit 10e30b3 added `payments.deposit_percent`. Still no `assistants`.
 * Today's shape also has `assistants.usp` (commit db42a3d). Add the next shape here when a
 * settings block is added; do not let these tests assume the newest one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ManualClock } from '@openbooking-sh/core';
import { MemoryBusinessStore, createHostedApp, starterSettings, type Business } from '../src';

const BASE = 'http://localhost:3000';
// Tuesday 6 October 2026, 09:00 in Oslo.
const NOW = '2026-10-06T07:00:00Z';
const DAY = '2026-10-08';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Stored = Business['settings'];

const SHAPES: Record<string, (s: Stored) => unknown> = {
  launch: (s) => {
    const old: any = structuredClone(s);
    delete old.payments;
    delete old.assistants;
    return old;
  },
  payments: (s) => {
    const old: any = structuredClone(s);
    delete old.assistants;
    return old;
  },
};

function setup() {
  const businesses = new MemoryBusinessStore();
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: 'test-secret-0123456789',
    clock: new ManualClock(NOW),
    businesses,
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
    return { status: res.status, json, text };
  };
  return { hosted, businesses, req };
}

/** Sign up, then rewrite the stored record to the given earlier shape, as a deploy would find it. */
async function businessSavedAs(shape: keyof typeof SHAPES) {
  const w = setup();
  const signup = await w.req('/api/signup', {
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
  await w.businesses.update('studio-nord', (b) => ({
    ...b,
    settings: SHAPES[shape]!(b.settings) as Stored,
    version: b.version + 1,
  }));
  return { ...w, token: signup.json.token as string };
}

describe.each(Object.keys(SHAPES))('a business saved with the %s settings shape', (shape) => {
  it('is stored without the blocks added later (the fixture is what it claims to be)', async () => {
    const { businesses } = await businessSavedAs(shape);
    const stored: any = (await businesses.get('studio-nord'))!.settings;
    expect(stored.assistants).toBeUndefined();
    expect('payments' in stored).toBe(shape === 'payments');
  });

  it('renders the booking page, the catalog and availability', async () => {
    const { req } = await businessSavedAs(shape);
    const html = await req('/b/studio-nord/book', { accept: 'text/html' });
    expect(html.status, html.text).toBe(200);
    expect(html.text).toContain('Studio Nord');

    const info = await req('/b/studio-nord/book/api/info');
    expect(info.status, info.text).toBe(200);
    expect(info.json.services.length).toBeGreaterThan(0);

    const service = info.json.services[0].id;
    const slots = await req(`/b/studio-nord/book/api/availability?date=${DAY}&service=${service}`);
    expect(slots.status, slots.text).toBe(200);
    expect(slots.json.slots.length).toBeGreaterThan(0);
  });

  it('books through the page with no deposit asked, even with Stripe connected', async () => {
    const { req, businesses } = await businessSavedAs(shape);
    await businesses.update('studio-nord', (b) => ({
      ...b,
      stripe: { secret_key: 'sk_test_old_1234' },
      version: b.version + 1,
    }));
    const info = await req('/b/studio-nord/book/api/info');
    const slots = await req(
      `/b/studio-nord/book/api/availability?date=${DAY}&service=${info.json.services[0].id}`,
    );
    const held = await req('/b/studio-nord/book/api/hold', {
      body: { slot_id: slots.json.slots[0].slot_id, idempotency_key: `hold-${shape}` },
    });
    expect(held.status, held.text).toBe(200);
    expect(held.json.booking.deposit).toBeNull();

    const confirmed = await req('/b/studio-nord/book/api/confirm', {
      body: {
        booking_id: held.json.booking.booking_id,
        idempotency_key: `confirm-${shape}`,
        customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
        user_confirmed: true,
      },
    });
    expect(confirmed.status, confirmed.text).toBe(200);
  });

  it('opens Studio and exports the account', async () => {
    const { req, token } = await businessSavedAs(shape);
    expect((await req('/studio', { accept: 'text/html' })).status).toBe(200);
    const view = await req('/studio/api/settings', { token });
    expect(view.status, view.text).toBe(200);
    expect(view.json.settings.profile.name).toBe('Studio Nord');
    expect((await req('/studio/api/account/export', { token })).status).toBe(200);
  });

  it('is listed in the OpenBooking app and offers no USP', async () => {
    const { hosted, req } = await businessSavedAs(shape);
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('host', new URL(url).host);
        return hosted.app.fetch(new Request(url, { ...init, headers }));
      },
    });
    const client = new Client(
      { name: 'claude-ai', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());
    const found = await client.callTool({ name: 'find_business', arguments: { query: 'hair' } });
    expect(found.isError).toBeFalsy();
    const ids = (found.structuredContent as any).businesses.map((b: any) => b.business_id);
    expect(ids).toEqual(['studio-nord']);

    // No `assistants` block counts as `off`.
    expect((await req('/b/studio-nord/.well-known/usp')).status).toBe(404);
  });

  it('can be saved again from what Studio shows, which fills in the new blocks', async () => {
    const { req, token, businesses } = await businessSavedAs(shape);
    const { settings } = (await req('/studio/api/settings', { token })).json;
    settings.profile.description = 'Hair, since 2012';
    const saved = await req('/studio/api/settings', { method: 'PUT', body: settings, token });
    expect(saved.status, saved.text).toBe(200);

    const stored = (await businesses.get('studio-nord'))!.settings;
    expect(stored.payments).toEqual({ deposit_percent: 0 });
    expect(stored.assistants).toEqual({ usp: 'off' });
    expect(stored.profile.description).toBe('Hair, since 2012');
  });

  it('can be saved by a client that sends only the old blocks (an open Studio tab, an API script)', async () => {
    const { req, token, businesses } = await businessSavedAs(shape);
    const old: any = SHAPES[shape]!(
      starterSettings({ name: 'Studio Nord', ownerName: 'Maria Berg', category: 'hair_salon' }),
    );
    const saved = await req('/studio/api/settings', { method: 'PUT', body: old, token });
    expect(saved.status, saved.text).toBe(200);
    const stored = (await businesses.get('studio-nord'))!.settings;
    expect(stored.payments.deposit_percent).toBe(0);
    expect(stored.assistants.usp).toBe('off');
  });
});
