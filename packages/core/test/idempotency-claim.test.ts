import { describe, expect, it } from 'vitest';
import { IdempotencyGuard, MemoryIdempotencyStore, type IdempotencyStore } from '../src';

// Two guards on one store stand in for two server instances sharing a database: each has its own
// in-flight map, so only the store can tell them apart.
const instances = (store: IdempotencyStore) => [
  new IdempotencyGuard(store),
  new IdempotencyGuard(store),
];

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('idempotency across instances', () => {
  it('runs a key once when two instances send it at the same instant', async () => {
    const [a, b] = instances(new MemoryIdempotencyStore());
    let runs = 0;
    const run = async () => {
      runs++;
      await later(30);
      return { id: `run-${runs}` };
    };
    const [x, y] = await Promise.all([
      a!.run('k', 'hold', { slot: 1 }, run),
      b!.run('k', 'hold', { slot: 1 }, run),
    ]);
    expect(runs).toBe(1);
    expect(x.value).toEqual(y.value);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
  });

  it('lets a waiting instance run when the first one failed (failures are not stored)', async () => {
    const [a, b] = instances(new MemoryIdempotencyStore());
    let calls = 0;
    const flaky = async () => {
      const n = ++calls;
      await later(30);
      if (n === 1) throw new Error('provider down');
      return { id: 'second' };
    };
    const [x, y] = await Promise.allSettled([
      a!.run('k', 'hold', {}, flaky),
      b!.run('k', 'hold', {}, flaky),
    ]);
    expect(calls).toBe(2);
    expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('answers a different request on the same key with a conflict, not a second run', async () => {
    const [a, b] = instances(new MemoryIdempotencyStore());
    let runs = 0;
    const run = async () => {
      runs++;
      await later(30);
      return { id: 'one' };
    };
    const [x, y] = await Promise.allSettled([
      a!.run('k', 'hold', { slot: 1 }, run),
      b!.run('k', 'hold', { slot: 2 }, run),
    ]);
    expect(runs).toBe(1);
    expect(x.status).toBe('fulfilled');
    expect(y).toMatchObject({ status: 'rejected', reason: { code: 'idempotency_conflict' } });
  });

  it('takes over a claim that was never finished once it has expired', async () => {
    let now = 1_000;
    const store = new MemoryIdempotencyStore(() => now);
    // An instance claimed the key and died before recording anything.
    await store.claim('k', 'hold:{}', 60_000);
    const guard = new IdempotencyGuard(store, undefined, () => now);
    let runs = 0;
    const pending = guard.run('k', 'hold', {}, async () => ++runs);
    await later(100);
    expect(runs).toBe(0); // still waiting on the live claim
    now += 61_000;
    await expect(pending).resolves.toMatchObject({ value: 1, replayed: false });
  });

  it('still works with a store that cannot claim (per-process join only)', async () => {
    const records = new MemoryIdempotencyStore();
    const plain: IdempotencyStore = {
      get: (k) => records.get(k),
      set: (k, r, t) => records.set(k, r, t),
    };
    const [a] = instances(plain);
    let runs = 0;
    const run = async () => ++runs;
    await a!.run('k', 'hold', {}, run);
    const again = await a!.run('k', 'hold', {}, run);
    expect(runs).toBe(1);
    expect(again.replayed).toBe(true);
  });
});
