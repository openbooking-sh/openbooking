/**
 * Hosted OpenBooking on Postgres: accounts, settings and limits survive a restart and are shared
 * between instances; plus the hosted stores on their own.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '@openbooking/core';
import { BusinessConflictError, createHostedApp, type Business } from '@openbooking/hosted';
import { MemoryMailer } from '@openbooking/notifications';
import {
  PostgresActivityLog,
  PostgresBusinessStore,
  PostgresCalendarLinkStore,
  PostgresNotificationLog,
  PostgresRateLimiter,
  postgresStores,
  type Db,
} from '../src';
import { freshDb, target } from './helpers';

const BASE = 'http://localhost:3000';
const NOW = '2026-10-06T07:00:00Z';

function business(id: string, email: string): Business {
  return {
    id,
    owner: { email, password_hash: 'scrypt$x$y' },
    settings: { listed: true } as Business['settings'],
    created_at: NOW,
    updated_at: NOW,
    version: 1,
  };
}

describe(`hosted stores (${target})`, () => {
  it('keeps businesses with unique ids and case-insensitive emails', async () => {
    const store = new PostgresBusinessStore(await freshDb());
    await store.create(business('studio-nord', 'Maria@Example.com'));
    await expect(store.create(business('studio-nord', 'other@example.com'))).rejects.toMatchObject({
      field: 'id',
    });
    const dupe = store.create(business('studio-sor', 'maria@example.COM'));
    await expect(dupe).rejects.toBeInstanceOf(BusinessConflictError);
    await expect(dupe).rejects.toMatchObject({ field: 'email' });

    expect((await store.getByEmail('MARIA@example.com'))?.id).toBe('studio-nord');
    const saved = await store.update('studio-nord', (b) => ({
      ...b,
      owner: { ...b.owner, email: 'new@example.com' },
      version: 2,
    }));
    expect(saved?.version).toBe(2);
    expect((await store.getByEmail('new@example.com'))?.version).toBe(2);
    expect(await store.getByEmail('maria@example.com')).toBeUndefined();
    expect(await store.update('nope', (b) => b)).toBeUndefined();
    expect((await store.list()).map((b) => b.id)).toEqual(['studio-nord']);
  });

  it('stores calendar links, claims notifications once, and counts rate limits', async () => {
    const db = await freshDb();
    const links = new PostgresCalendarLinkStore(db);
    await links.set('bk_1', { calendar_id: 'primary', event_id: 'ev1' });
    await links.set('bk_1', { calendar_id: 'primary', event_id: 'ev2' });
    expect(await links.get('bk_1')).toEqual({ calendar_id: 'primary', event_id: 'ev2' });
    await links.delete('bk_1');
    expect(await links.get('bk_1')).toBeUndefined();

    const log = new PostgresNotificationLog(db);
    const claims = await Promise.all([log.claim('k'), log.claim('k'), log.claim('k')]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    let now = Date.parse(NOW);
    const limiter = new PostgresRateLimiter(db, { now: () => now });
    const hits = [];
    for (let i = 0; i < 4; i++) hits.push(await limiter.hit('login:a', 3, 60_000));
    expect(hits).toEqual([true, true, true, false]);
    now += 60_000;
    expect(await limiter.hit('login:a', 3, 60_000)).toBe(true);
  });

  it('keeps activity separate per business', async () => {
    const db = await freshDb();
    const a = new PostgresActivityLog(db, { scope: 'a' });
    const b = new PostgresActivityLog(db, { scope: 'b' });
    const entry = {
      at: NOW,
      operation: 'search' as const,
      ok: true,
      agent: 'Claude',
      protocol: 'mcp',
    };
    await a.add(entry);
    await b.add({ ...entry, agent: 'ChatGPT' });
    expect((await a.list()).map((e) => e.agent)).toEqual(['Claude']);
    expect((await b.list()).map((e) => e.agent)).toEqual(['ChatGPT']);
  });
});

describe(`hosted OpenBooking on postgres (${target})`, () => {
  function boot(db: Db, mailer: MemoryMailer) {
    const clock = new ManualClock(NOW);
    const stores = postgresStores(db);
    const hosted = createHostedApp({
      baseUrl: BASE,
      sessionSecret: 'test-secret-0123456789',
      clock,
      businesses: stores.businesses,
      bookings: stores.bookings,
      idempotency: stores.idempotency,
      activityFor: stores.activityFor,
      calendarLinks: stores.calendarLinks,
      notificationLog: stores.notificationLog,
      rateLimiter: new PostgresRateLimiter(db, { now: () => clock.now().getTime() }),
      mail: { mailer, from: 'bookings@openbooking.sh' },
    });
    const req = async (path: string, body?: unknown, token?: string) => {
      const res = await hosted.app.request(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        json: text ? JSON.parse(text) : undefined,
      };
    };
    return { hosted, req };
  }

  it('keeps accounts across a restart and shares rate limits between instances', async () => {
    const db = await freshDb();
    const mailer = new MemoryMailer();
    const first = boot(db, mailer);
    const signup = await first.req('/api/signup', {
      business_name: 'Studio Nord',
      your_name: 'Maria',
      email: 'maria@example.com',
      password: 'correct horse',
      category: 'hair_salon',
      city: 'Oslo',
    });
    expect(signup.status, JSON.stringify(signup.json)).toBe(200);
    await first.hosted.idle();

    // A fresh instance on the same database: the account, session and settings are all there.
    const second = boot(db, mailer);
    const view = await second.req('/studio/api/settings', undefined, signup.json.token);
    expect(view.status).toBe(200);
    expect(view.json.settings.profile.name).toBe('Studio Nord');
    expect(view.json.account).toMatchObject({ email: 'maria@example.com', email_verified: false });

    // The confirmation link from the first instance works on the second.
    const confirm = mailer.sent.find((m) => m.subject.startsWith('Confirm'))!;
    const url = new URL(/https?:\/\/\S+/.exec(confirm.text)![0]);
    const clicked = await second.req(url.pathname + url.search);
    expect(clicked.headers.get('location')).toContain('verified=yes');
    expect(
      (await first.hosted.businesses.get('studio-nord'))?.owner.email_verified_at,
    ).toBeTruthy();

    // Ten wrong passwords spread over both instances, then the right one is still blocked.
    const login = (app: typeof first, password: string) =>
      app.req('/api/login', { email: 'maria@example.com', password });
    for (let i = 0; i < 10; i++) {
      expect((await login(i % 2 ? first : second, `guess-${i}`)).status).toBe(401);
    }
    expect((await login(first, 'correct horse')).status).toBe(429);

    await first.hosted.close();
    await second.hosted.close();
  });
});
