import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import { createUsp, negotiate, USP, USP_AUTHORITY, USP_VERSION } from '../src';
import { platform } from './platform';
import { platformProfile, stubProfiles } from './platform-profile';
import { messageErrors, problemErrors } from './spec';

const entry = (version = USP_VERSION) => [{ version }];

describe('negotiate', () => {
  it('uses everything both sides have', () => {
    expect(negotiate(platformProfile())).toEqual({
      kind: 'ok',
      capabilities: {
        [USP.catalog]: USP_VERSION,
        [USP.availability]: USP_VERSION,
        [USP.bookings]: USP_VERSION,
      },
    });
  });

  it('uses only the capabilities in common', () => {
    const n = negotiate(
      platformProfile({ capabilities: { [USP.catalog]: entry(), [USP.availability]: entry() } }),
    );
    expect(n.kind === 'ok' && Object.keys(n.capabilities).sort()).toEqual([
      USP.availability,
      USP.catalog,
    ]);
  });

  it('ignores capabilities the business does not have', () => {
    const n = negotiate(
      platformProfile({
        capabilities: { [USP.bookings]: entry(), 'com.example.loyalty': entry() },
      }),
    );
    expect(n.kind === 'ok' && Object.keys(n.capabilities)).toEqual([USP.bookings]);
  });

  it('picks the highest version both sides share', () => {
    const business = { [USP.bookings]: ['2026-06-15', '2026-08-20', '2026-09-30'] };
    const platformSide = platformProfile({
      version: '2026-08-20',
      capabilities: { [USP.bookings]: [{ version: '2026-06-15' }, { version: '2026-08-20' }] },
    });
    expect(negotiate(platformSide, business)).toEqual({
      kind: 'ok',
      capabilities: { [USP.bookings]: '2026-08-20' },
    });
  });

  it('is incompatible when nothing is shared, including when only the versions differ', () => {
    expect(negotiate(platformProfile({ capabilities: {} })).kind).toBe('incompatible');
    expect(
      negotiate(platformProfile({ capabilities: { [USP.bookings]: entry('2026-01-01') } })).kind,
    ).toBe('incompatible');
  });

  it('refuses a platform that speaks a newer version than the business', () => {
    expect(negotiate(platformProfile({ version: '2027-01-01' }))).toEqual({
      kind: 'version_unsupported',
      latest: USP_VERSION,
    });
    // An older platform is served.
    expect(negotiate(platformProfile({ version: '2026-01-01' })).kind).toBe('ok');
  });
});

describe('negotiation on privileged calls', () => {
  const PUBLIC = 'https://hosted.example/b/studio-nord';
  const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;

  function setup(profile = platformProfile()) {
    const clock = new ManualClock('2026-10-01T08:00:00Z');
    const service = new BookingService({ provider: createDemoSalonProvider(), clock });
    const stub = stubProfiles(profile);
    const usp = createUsp({
      service,
      baseUrl: PUBLIC,
      consent: 'commit',
      platformProfiles: stub.fetcher,
    });
    return { clock, service, app: new Hono().route(usp.path, usp.router), stub };
  }

  const slot = async (w: ReturnType<typeof setup>) => {
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

  const buyer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

  it('serves a platform that can use what the business offers', async () => {
    const w = setup();
    const p = await platform(w, 'https://agent.example/p.json', PUBLIC);
    const res = await p.call('POST', '/availability/holds', {
      slot_id: (await slot(w)).id,
      service_id: 'haircut',
    });
    expect(res.status).toBe(201);
    expect(w.stub.calls).toEqual(['https://agent.example/p.json']);
  });

  it('answers a platform that cannot use bookings with capabilities_incompatible, and books nothing', async () => {
    const w = setup(
      platformProfile({ capabilities: { [USP.catalog]: entry(), [USP.availability]: entry() } }),
    );
    const p = await platform(w, 'https://agent.example/p.json', PUBLIC);
    const s = await slot(w);
    const res = await p.call(
      'POST',
      '/bookings',
      { service_id: 'haircut', slot_id: s.id, buyer },
      { headers: { 'idempotency-key': 'neg-create-0001' } },
    );
    // A valid request with nothing to act on: a business outcome (200), not an error status.
    expect(res.status).toBe(200);
    expect(res.json.booking).toBeUndefined();
    const m = res.json.messages[0];
    expect(m).toMatchObject({ type: 'error', code: 'capabilities_incompatible' });
    expect(messageErrors(m)).toEqual([]);
    // The slot is still free: nothing was held on the way. Availability is shared, so holds work.
    const hold = await p.call('POST', '/availability/holds', {
      slot_id: s.id,
      service_id: 'haircut',
    });
    expect(hold.status).toBe(201);
  });

  it('answers a platform that shares nothing with capabilities_incompatible on every privileged call', async () => {
    const w = setup(platformProfile({ capabilities: { 'com.example.other': entry() } }));
    const p = await platform(w, 'https://agent.example/p.json', PUBLIC);
    const s = await slot(w);
    const res = await p.call('POST', '/availability/holds', {
      slot_id: s.id,
      service_id: 'haircut',
    });
    expect(res.status).toBe(200);
    expect(res.json.messages[0].code).toBe('capabilities_incompatible');
    expect(res.json.usp.capabilities).toEqual({});
  });

  it('refuses a platform that speaks a newer version, naming the latest supported one', async () => {
    const w = setup(platformProfile({ version: '2027-06-01' }));
    const p = await platform(w, 'https://agent.example/p.json', PUBLIC);
    const res = await p.call('POST', '/availability/holds', {
      slot_id: (await slot(w)).id,
      service_id: 'haircut',
    });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe(type('version-unsupported'));
    expect(problemErrors(res.json)).toEqual([]);
    expect(res.json.messages[0]).toMatchObject({ code: 'latest_supported_version' });
    expect(res.json.messages[0].content).toContain(USP_VERSION);
  });

  it('does not fetch a profile for the public operations', async () => {
    const w = setup();
    const res = await w.app.request('/usp/services/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'usp-agent': 'profile="https://agent.example/p.json"',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(w.stub.calls).toEqual([]);
  });
});
