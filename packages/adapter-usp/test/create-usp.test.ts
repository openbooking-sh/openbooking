import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import { createUsp, MemoryUspState, scopeUspState, USP_AUTHORITY } from '../src';
import { platform } from './platform';
import { stubProfiles } from './platform-profile';
import { profileErrors } from './spec';

const PUBLIC = 'https://hosted.example/b/studio-nord';
const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;

/**
 * A business served under a path prefix, as hosted does: the app only ever sees `/usp/...`
 * (the prefix is stripped before it gets there), but platforms sign the public URL.
 */
function setup(options: { consent?: 'action' | 'commit' } = {}) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const consent = options.consent ?? 'commit';
  const usp = createUsp({
    service,
    baseUrl: `${PUBLIC}/`,
    businessId: 'studio-nord',
    platformProfiles: stubProfiles().fetcher,
    consent,
    ...(consent === 'action'
      ? { continueUrl: (b: { booking_id: string }) => `${PUBLIC}/book/confirm/${b.booking_id}` }
      : {}),
  });
  const app = new Hono()
    .route(usp.path, usp.router)
    .get('/.well-known/usp', async (c) => c.json(await usp.profile()));
  return { clock, service, usp, app };
}

const firstSlot = async (w: ReturnType<typeof setup>) => {
  const res = await w.app.request('/usp/availability/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: 'haircut',
      start_date: '2026-10-16',
      end_date: '2026-10-16',
      resource_id: 'maria',
      limit: 1,
    }),
  });
  return ((await res.json()) as any).slots[0] as { id: string };
};

describe('createUsp behind a path prefix', () => {
  it('checks proofs against the public URL, not the one the proxy forwards', async () => {
    const w = setup();
    const slot = await firstSlot(w);
    const body = { slot_id: slot.id, service_id: 'haircut' };

    // Signed for the public address, the way a platform learned it from the profile.
    const right = await platform(w, 'https://agent.example/p.json', PUBLIC);
    expect((await right.call('POST', '/availability/holds', body)).status).toBe(201);

    // Signed for the internal address the app sees: refused. A proof must not be good for a
    // URL no platform was ever told about.
    const wrong = await platform(w, 'https://agent.example/q.json', 'https://hosted.example');
    const res = await wrong.call('POST', '/availability/holds', body);
    expect(res.status).toBe(401);
    expect(res.json.type).toBe(type('pop-proof-invalid'));
  });

  it('serves a valid profile whose endpoint is the public URL', async () => {
    const w = setup();
    const profile = (await (await w.app.request('/.well-known/usp')).json()) as any;
    expect(profileErrors(profile)).toEqual([]);
    expect(profile.usp.services['dev.usp-protocol.services'][0].endpoint).toBe(`${PUBLIC}/usp`);
    expect(profile.usp.business).toMatchObject({ name: 'Studio Nord', currency: 'NOK' });
    expect(profile.authorization.accepted_mechanisms).toContain('platform_key_pop');
  });

  it('uses the business id given, so businesses sharing a host stay distinct', async () => {
    const w = setup();
    const json = (await (await w.app.request('/usp/services/haircut')).json()) as any;
    expect(json.service.business_id).toBe('studio-nord');
  });

  it('sends the buyer to the confirm page in the default consent mode', async () => {
    const w = setup({ consent: 'action' });
    const slot = await firstSlot(w);
    const p = await platform(w, 'https://agent.example/p.json', PUBLIC);
    const res = await p.call(
      'POST',
      '/bookings',
      {
        service_id: 'haircut',
        slot_id: slot.id,
        buyer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      },
      { headers: { 'idempotency-key': 'create-key-0001' } },
    );
    expect(res.status).toBe(201);
    expect(res.json.booking.status).toBe('requires_action');
    expect(res.json.booking.actions[0].continue_url).toBe(
      `${PUBLIC}/book/confirm/${res.json.booking.id}`,
    );
  });

  it('refuses to start without somewhere to send the buyer (consent action)', () => {
    const service = new BookingService({ provider: createDemoSalonProvider() });
    expect(() => createUsp({ service, baseUrl: PUBLIC, platformProfiles: false })).toThrow(
      /continueUrl/,
    );
  });
});

describe('scopeUspState', () => {
  it('keeps businesses apart for request keys, proofs and key bindings', async () => {
    const shared = new MemoryUspState();
    const a = scopeUspState(shared, 'business-a');
    const b = scopeUspState(shared, 'business-b');

    expect(await a.checkKey('k', 'fp-1')).toBe(true);
    expect(await b.checkKey('k', 'fp-2')).toBe(true); // no collision across businesses
    expect(await a.checkKey('k', 'fp-2')).toBe(false); // still strict inside one

    expect(await a.seenJti('jti', 1000)).toBe(false);
    expect(await b.seenJti('jti', 1000)).toBe(false);
    expect(await a.seenJti('jti', 1000)).toBe(true);

    expect(await a.bindProfile('jkt', 'https://one.example/p')).toBe(true);
    expect(await b.bindProfile('jkt', 'https://two.example/p')).toBe(true); // its own first use
    expect(await a.bindProfile('jkt', 'https://two.example/p')).toBe(false);
  });

  it('shares what is globally unique: owners and credentials', async () => {
    const shared = new MemoryUspState();
    const a = scopeUspState(shared, 'business-a');
    const b = scopeUspState(shared, 'business-b');
    await a.claim('bk_1', 'platform');
    expect(await b.ownerOf('bk_1')).toBe('platform');
    await a.saveCredential({ hash: 'h', expiresAt: new Date('2031-01-01'), scope: [] });
    expect(await b.findCredential('h')).toBeDefined();
  });
});
