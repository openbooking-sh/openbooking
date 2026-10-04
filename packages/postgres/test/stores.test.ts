import { describe, expect, it } from 'vitest';
import type { CalcomRecord } from '@openbooking/provider-calcom';
import { describeBookingStore, record } from '../../provider-memory/test/store-contract';
import {
  MIGRATIONS,
  PostgresActivityLog,
  PostgresBookingStore,
  PostgresCalcomStore,
  PostgresIdempotencyStore,
  migrate,
} from '../src';
import { freshDb, target } from './helpers';

describeBookingStore(`postgres (${target})`, async () => new PostgresBookingStore(await freshDb()));

describe(`migrations (${target})`, () => {
  it('applies once and is a no-op afterwards', async () => {
    const db = await freshDb(); // already migrated
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ version: number }>('select version from ob_migrations');
    expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
  });
});

describe(`PostgresIdempotencyStore (${target})`, () => {
  it('stores, replays and expires records', async () => {
    let now = Date.parse('2030-01-01T00:00:00Z');
    const store = new PostgresIdempotencyStore(await freshDb(), { now: () => now });
    const rec = {
      fingerprint: 'hold:{"a":1}',
      value: { booking_id: 'bk_1', n: [1, 2] },
      created_at: now,
    };
    expect(await store.get('k1')).toBeUndefined();
    await store.set('k1', rec, 60_000);
    expect(await store.get('k1')).toEqual(rec);

    now += 60_000;
    expect(await store.get('k1')).toBeUndefined();
    expect(await store.purgeExpired()).toBe(1);
  });

  it('keeps undefined and array results intact', async () => {
    const store = new PostgresIdempotencyStore(await freshDb());
    await store.set('void', { fingerprint: 'f', value: undefined, created_at: 1 }, 60_000);
    await store.set('arr', { fingerprint: 'f', value: ['a', 'b'], created_at: 1 }, 60_000);
    expect((await store.get('void'))?.value).toBeUndefined();
    expect((await store.get('arr'))?.value).toEqual(['a', 'b']);
  });
});

describe(`PostgresActivityLog (${target})`, () => {
  const entry = (over: Record<string, unknown>) => ({
    at: '2030-01-01T10:00:00.000Z',
    operation: 'hold' as const,
    ok: true,
    agent: 'Claude',
    protocol: 'mcp',
    ...over,
  });

  it('lists newest first with after/booking filters', async () => {
    const log = new PostgresActivityLog(await freshDb());
    const a = await log.add(entry({ booking_id: 'bk_1' }));
    const b = await log.add(entry({ operation: 'search' }));
    const c = await log.add(
      entry({ operation: 'confirm', booking_id: 'bk_1', status: 'confirmed' }),
    );
    expect((await log.list()).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect((await log.list({ after: a.id })).map((e) => e.id)).toEqual([c.id, b.id]);
    expect((await log.list({ booking_id: 'bk_1', limit: 1 }))[0]).toEqual(c);
  });

  it('credits the confirming agent, otherwise the first holder', async () => {
    const log = new PostgresActivityLog(await freshDb());
    await log.add(entry({ booking_id: 'bk_1', agent: 'ChatGPT' }));
    await log.add(entry({ booking_id: 'bk_1', agent: 'Gemini' }));
    await log.add(entry({ booking_id: 'bk_2', agent: 'ChatGPT' }));
    await log.add(entry({ operation: 'confirm', booking_id: 'bk_2', agent: 'Claude' }));
    await log.add(entry({ operation: 'confirm', booking_id: 'bk_3', agent: 'Claude', ok: false }));
    const via = await log.bookedVia(['bk_1', 'bk_2', 'bk_3']);
    expect(Object.fromEntries(via)).toEqual({ bk_1: 'ChatGPT', bk_2: 'Claude' });
    expect(await log.bookedVia([])).toEqual(new Map());
  });
});

describe(`PostgresCalcomStore (${target})`, () => {
  it('puts, updates and lists records', async () => {
    const store = new PostgresCalcomStore(await freshDb());
    const r1: CalcomRecord = {
      booking: record({ id: 'bk_a' }).booking,
      eventTypeId: 42,
      reservationUid: 'res_1',
      calUid: null,
    };
    await store.put(r1);
    await store.put({ ...r1, booking: record({ id: 'bk_b' }).booking });
    await store.put({ ...r1, reservationUid: null, calUid: 'cal_1' });
    expect(await store.get('bk_a')).toMatchObject({ calUid: 'cal_1', reservationUid: null });
    expect(await store.get('nope')).toBeUndefined();
    expect((await store.list()).map((r) => r.booking.booking_id)).toEqual(['bk_a', 'bk_b']);
  });
});
