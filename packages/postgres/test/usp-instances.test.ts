/**
 * Two server instances (two BookingServices, two routers, two authenticators) sharing one
 * Postgres database: what a serverless deployment looks like. State kept in memory would be
 * split between them: a credential issued by one unknown to the other, a replayed proof caught
 * by only one. With the shared store they behave as one server.
 */
import {
  createPopAuthenticator,
  createUspRouter,
  USP_AUTHORITY,
  type UspStateStore,
} from '@openbooking-sh/adapter-usp';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { platform, b64, ORIGIN } from '../../adapter-usp/test/platform';
import { postgresStores, type Db } from '../src';
import { freshDb, target } from './helpers';

const BUYER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const type = (slug: string) => `${USP_AUTHORITY}/errors/${slug}`;

const clock = new ManualClock('2026-10-01T08:00:00Z');

/** One server instance on the shared database. */
function instance(db: Db) {
  const now = () => clock.now().getTime();
  const stores = postgresStores(db, { idempotency: { now }, usp: { now } });
  const service = new BookingService({
    provider: createDemoSalonProvider({ store: stores.bookings }),
    clock,
    idempotencyStore: stores.idempotency,
  });
  // Assigning to the adapter's interface is the compatibility check this package cannot make in
  // its own source (it must not depend on the adapter there).
  const state: UspStateStore = stores.usp;
  const auth = createPopAuthenticator({ baseUrl: ORIGIN, state, clock });
  return new Hono().route(
    '/usp',
    createUspRouter({ service, baseUrl: ORIGIN, consent: 'commit', auth, state }),
  );
}

/** Both instances behind one address; a header picks which one answers. */
function cluster(db: Db) {
  const instances = { a: instance(db), b: instance(db) };
  const app = new Hono().all('*', (c) => {
    const which = c.req.header('x-instance') === 'b' ? 'b' : 'a';
    return instances[which].fetch(c.req.raw);
  });
  return { app, clock };
}

const onB = { headers: { 'x-instance': 'b' } };

async function firstSlot(w: { app: Hono }, date: string) {
  const res = await w.app.request('/usp/availability/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: 'haircut',
      start_date: date,
      end_date: date,
      resource_id: 'maria',
      limit: 2,
    }),
  });
  return ((await res.json()) as any).slots[0] as { id: string };
}

const create = (
  p: Awaited<ReturnType<typeof platform>>,
  slot: { id: string },
  key: string,
  extra = {},
) =>
  p.call(
    'POST',
    '/bookings',
    { service_id: 'haircut', slot_id: slot.id, buyer: BUYER },
    { headers: { 'idempotency-key': key, ...extra } },
  );

describe(`USP state shared through Postgres (${target})`, () => {
  it('knows on one instance the credential another issued, and its owner', async () => {
    const w = cluster(await freshDb());
    const p = await platform(w);
    const slot = await firstSlot(w, '2026-10-16');
    const made = await create(p, slot, 'pg-create-0001'); // instance A
    expect(made.status).toBe(201);
    const id = made.json.booking.id as string;
    const cred = made.json.booking_scoped_credential.value as string;

    // Instance B has never seen this booking or credential in memory.
    const read = await p.call('GET', `/bookings/${id}`, undefined, { credential: cred, ...onB });
    expect(read.status).toBe(200);
    expect(read.json.booking.id).toBe(id);

    // Nor has it forgotten who owns it: another platform is still turned away.
    const stranger = await platform(w, 'https://other.example/p.json');
    expect((await stranger.call('GET', `/bookings/${id}`, undefined, onB)).status).toBe(404);
    expect((await p.call('GET', `/bookings/${id}`, undefined, onB)).status).toBe(200);
  });

  it('catches a proof replayed against the other instance', async () => {
    const w = cluster(await freshDb());
    const p = await platform(w);
    const slot = await firstSlot(w, '2026-10-16');
    const made = await create(p, slot, 'pg-create-0002');
    const id = made.json.booking.id as string;
    const cred = made.json.booking_scoped_credential.value as string;

    const proof = await p.proof('GET', `/usp/bookings/${id}`, {
      credential: cred,
      jti: 'shared-jti',
    });
    const send = (instance: 'a' | 'b') =>
      w.app.request(`/usp/bookings/${id}`, {
        headers: {
          'usp-agent': 'profile="https://agent.example/profile.json"',
          authorization: `DPoP ${cred}`,
          dpop: proof,
          'x-instance': instance,
        },
      });
    expect((await send('a')).status).toBe(200);
    const replay = await send('b'); // a captured proof, resent to the other instance
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).type).toBe(type('pop-proof-replayed'));
  });

  it('keeps a key tied to the profile it first presented, whichever instance sees it', async () => {
    const w = cluster(await freshDb());
    const p = await platform(w, 'https://agent.example/one.json');
    const slot = await firstSlot(w, '2026-10-16');
    const body = { slot_id: slot.id, service_id: 'haircut' };
    expect((await p.call('POST', '/availability/holds', body)).status).toBe(201); // instance A
    const other = await p.call('POST', '/availability/holds', body, {
      headers: { 'x-instance': 'b', 'usp-agent': 'profile="https://agent.example/two.json"' },
    });
    expect(other.status).toBe(403);
    expect(other.json.type).toBe(type('profile-not-trusted'));
  });

  it('applies the same request-key rules across instances', async () => {
    const w = cluster(await freshDb());
    const p = await platform(w);
    const slot = await firstSlot(w, '2026-10-16');
    const first = await create(p, slot, 'pg-create-0003'); // A
    const again = await create(p, slot, 'pg-create-0003', onB.headers); // B, same request
    expect(again.status).toBe(201);
    expect(again.json.booking.id).toBe(first.json.booking.id);

    const different = await p.call(
      'POST',
      '/bookings',
      { service_id: 'haircut', slot_id: slot.id, buyer: { ...BUYER, first_name: 'Grace' } },
      { headers: { 'idempotency-key': 'pg-create-0003', ...onB.headers } },
    );
    expect(different.status).toBe(409);
    expect(different.json.type).toBe(type('idempotency-conflict'));
  });

  it('shares the slot itself: a hold on one instance blocks the other', async () => {
    const w = cluster(await freshDb());
    const a = await platform(w, 'https://a.example/p.json');
    const b = await platform(w, 'https://b.example/p.json');
    const slot = await firstSlot(w, '2026-10-17');
    const body = { slot_id: slot.id, service_id: 'haircut' };
    expect((await a.call('POST', '/availability/holds', body)).status).toBe(201);
    const second = await b.call('POST', '/availability/holds', body, onB);
    expect(second.status).toBe(200);
    expect(second.json.messages[0].code).toBe('slot_unavailable');
  });

  it('survives a restart: new instances on the same database still honour the credential', async () => {
    const db = await freshDb();
    const before = cluster(db);
    const p = await platform(before);
    const slot = await firstSlot(before, '2026-10-20');
    const made = await create(p, slot, 'pg-create-0004');
    const id = made.json.booking.id as string;
    const cred = made.json.booking_scoped_credential.value as string;
    expect(b64(cred)).toBeTruthy();

    // Brand-new instances, as after a deploy or a cold start.
    const after = cluster(db);
    p.use(after);
    const read = await p.call('GET', `/bookings/${id}`, undefined, { credential: cred });
    expect(read.status).toBe(200);
    expect(read.json.booking.status).toBe('confirmed');
  });
});
