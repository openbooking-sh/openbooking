/**
 * The contract every `UspStateStore` must meet, run against the in-memory store here and against
 * Postgres in packages/postgres (the same pattern as provider-memory's store contract). The
 * races matter most: two server instances must never both accept one proof or one first claim.
 */
import { describe, expect, it } from 'vitest';
import type { UspStateStore } from '../src';

export interface TestClock {
  now: number;
}

export function describeUspState(
  name: string,
  make: (clock: TestClock) => Promise<UspStateStore> | UspStateStore,
) {
  const setup = async () => {
    const clock: TestClock = { now: Date.parse('2030-01-01T00:00:00Z') };
    return { clock, store: await make(clock) };
  };

  describe(`UspStateStore contract: ${name}`, () => {
    describe('owners', () => {
      it('gives a hold to the first claimant only', async () => {
        const { store } = await setup();
        expect(await store.ownerOf('bk_1')).toBeUndefined();
        expect(await store.claim('bk_1', 'platform-a')).toBe(true);
        expect(await store.claim('bk_1', 'platform-a')).toBe(true); // the same platform again
        expect(await store.claim('bk_1', 'platform-b')).toBe(false);
        expect(await store.ownerOf('bk_1')).toBe('platform-a');
        expect(await store.ownerOf('bk_2')).toBeUndefined();
      });

      it('lets exactly one of several racing claimants win', async () => {
        const { store } = await setup();
        const results = await Promise.all(
          ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => store.claim('bk_race', p)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('knows which holds became bookings', async () => {
        const { store } = await setup();
        await store.claim('bk_1', 'platform-a');
        expect(await store.isBooking('bk_1')).toBe(false);
        await store.markBooking('bk_1');
        await store.markBooking('bk_1'); // harmless twice
        expect(await store.isBooking('bk_1')).toBe(true);
        expect(await store.isBooking('bk_2')).toBe(false);
        await store.markBooking('never-claimed');
        expect(await store.ownerOf('never-claimed')).toBeUndefined();
      });
    });

    describe('idempotency keys', () => {
      it('accepts a key again for the same request and refuses it for a different one', async () => {
        const { store } = await setup();
        expect(await store.checkKey('k1', 'fp-a')).toBe(true);
        expect(await store.checkKey('k1', 'fp-a')).toBe(true);
        expect(await store.checkKey('k1', 'fp-b')).toBe(false);
        expect(await store.checkKey('k2', 'fp-b')).toBe(true); // keys are independent
      });

      it('lets exactly one of two different requests claim a fresh key', async () => {
        const { store } = await setup();
        const results = await Promise.all([
          store.checkKey('k-race', 'fp-a'),
          store.checkKey('k-race', 'fp-b'),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe('credentials', () => {
      const credential = (hash: string, extra: Record<string, unknown> = {}) => ({
        hash,
        expiresAt: new Date('2031-01-01T00:00:00Z'),
        jkt: 'jkt-1',
        scope: ['booking:bk_1'],
        ...extra,
      });

      it('round-trips a credential by its hash', async () => {
        const { store } = await setup();
        expect(await store.findCredential('h1')).toBeUndefined();
        await store.saveCredential(credential('h1'));
        expect(await store.findCredential('h1')).toEqual(credential('h1'));
        expect(await store.findCredential('h2')).toBeUndefined();
      });

      it('keeps a credential without a bound key as one without', async () => {
        const { store } = await setup();
        await store.saveCredential({
          hash: 'h3',
          expiresAt: new Date('2031-01-01T00:00:00Z'),
          scope: [],
        });
        const found = await store.findCredential('h3');
        expect(found?.jkt).toBeUndefined();
        expect(found?.scope).toEqual([]);
      });

      it('does not overwrite an existing credential', async () => {
        const { store } = await setup();
        await store.saveCredential(credential('h1'));
        await store.saveCredential(credential('h1', { scope: ['booking:other'], jkt: 'jkt-2' }));
        expect((await store.findCredential('h1'))?.scope).toEqual(['booking:bk_1']);
      });

      it('still returns an expired credential: the verifier judges expiry', async () => {
        const { store } = await setup();
        await store.saveCredential(
          credential('old', { expiresAt: new Date('2020-01-01T00:00:00Z') }),
        );
        expect((await store.findCredential('old'))?.expiresAt).toEqual(
          new Date('2020-01-01T00:00:00Z'),
        );
      });
    });

    describe('proof replay memory', () => {
      it('reports a proof it has seen, until its time runs out', async () => {
        const { store, clock } = await setup();
        expect(await store.seenJti('jti-1', 120_000)).toBe(false);
        expect(await store.seenJti('jti-1', 120_000)).toBe(true);
        expect(await store.seenJti('jti-2', 120_000)).toBe(false); // independent
        clock.now += 121_000;
        expect(await store.seenJti('jti-1', 120_000)).toBe(false); // forgotten
        expect(await store.seenJti('jti-1', 120_000)).toBe(true); // and remembered again
      });

      it('lets exactly one of several simultaneous uses of a proof through', async () => {
        const { store } = await setup();
        const seen = await Promise.all(
          Array.from({ length: 8 }, () => store.seenJti('jti-race', 120_000)),
        );
        expect(seen.filter((s) => !s)).toHaveLength(1);
      });
    });

    describe('profile bindings (trust on first use)', () => {
      it('binds a key to the first profile it presents', async () => {
        const { store } = await setup();
        expect(await store.bindProfile('jkt-1', 'https://a.example/p.json')).toBe(true);
        expect(await store.bindProfile('jkt-1', 'https://a.example/p.json')).toBe(true);
        expect(await store.bindProfile('jkt-1', 'https://b.example/p.json')).toBe(false);
        // Another key may share a profile.
        expect(await store.bindProfile('jkt-2', 'https://a.example/p.json')).toBe(true);
      });

      it('lets exactly one of two racing profiles bind', async () => {
        const { store } = await setup();
        const results = await Promise.all([
          store.bindProfile('jkt-race', 'https://a.example/p.json'),
          store.bindProfile('jkt-race', 'https://b.example/p.json'),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });
  });
}
