/**
 * Behaviour every GuardStore must have. Run with `describeGuardStore(name, factory)`; used for the
 * memory store here and for the Postgres store in @openbooking-sh/postgres.
 */
import { describe, expect, it } from 'vitest';
import type { GuardEntry, GuardStore } from '../src';

const HOUR = 3_600_000;
export const NOW = new Date('2030-06-01T10:00:00Z');
const T = NOW.getTime();

let seq = 0;
export function entry(over: Partial<GuardEntry> = {}): GuardEntry {
  const start = over.start_ms ?? T + 24 * HOUR;
  return {
    booking_id: `g${++seq}`,
    venue_id: 'v1',
    day: new Date(start).toISOString().slice(0, 10),
    start_ms: start,
    end_ms: start + HOUR,
    status: 'held',
    hold_expires_ms: T + 10 * 60_000,
    guest_keys: ['e:alice'],
    name_key: 'n:alice',
    agent_key: null,
    created_ms: T,
    cancelled_ms: null,
    cancelled_from: null,
    flags: [],
    ...over,
  };
}

export function describeGuardStore(name: string, factory: () => Promise<GuardStore> | GuardStore) {
  describe(`guard store: ${name}`, () => {
    it('refuses a claim over the guest limit and counts only active bookings', async () => {
      const store = await factory();
      const limits = { guest_venue: 2 };
      expect(await store.claim(entry(), limits, NOW)).toEqual({ ok: true });
      const second = entry();
      expect(await store.claim(second, limits, NOW)).toEqual({ ok: true });
      expect(await store.claim(entry(), limits, NOW)).toEqual({ ok: false, limit: 'guest_venue' });

      // Cancelled bookings stop counting ...
      await store.release(second.booking_id, NOW);
      expect(await store.claim(entry(), limits, NOW)).toEqual({ ok: true });
      // ... and so do holds that have lapsed.
      const later = new Date(T + 11 * 60_000);
      expect(await store.claim(entry({ guest_keys: ['e:bob'] }), limits, later)).toEqual({
        ok: true,
      });
    });

    it('stops counting a booking once it is over, but confirmed ones count until then', async () => {
      const store = await factory();
      const limits = { guest_venue: 1 };
      await store.claim(
        entry({ status: 'confirmed', hold_expires_ms: null, start_ms: T + HOUR }),
        limits,
        NOW,
      );
      expect(await store.claim(entry(), limits, NOW)).toEqual({ ok: false, limit: 'guest_venue' });
      const after = new Date(T + 3 * HOUR);
      expect(await store.claim(entry({ start_ms: T + 30 * HOUR }), limits, after)).toEqual({
        ok: true,
      });
    });

    it('limits per day separately from per venue', async () => {
      const store = await factory();
      const limits = { guest_day: 1 };
      await store.claim(entry({ start_ms: T + 24 * HOUR }), limits, NOW);
      expect(await store.claim(entry({ start_ms: T + 26 * HOUR }), limits, NOW)).toEqual({
        ok: false,
        limit: 'guest_day',
      });
      expect(await store.claim(entry({ start_ms: T + 48 * HOUR }), limits, NOW)).toEqual({
        ok: true,
      });
    });

    it('matches a guest by either key, and keeps venues apart', async () => {
      const store = await factory();
      const limits = { guest_venue: 1 };
      await store.claim(entry({ guest_keys: ['e:x', 'p:y'] }), limits, NOW);
      expect(await store.claim(entry({ guest_keys: ['p:y'] }), limits, NOW)).toEqual({
        ok: false,
        limit: 'guest_venue',
      });
      expect(
        await store.claim(entry({ guest_keys: ['p:y'], venue_id: 'v2' }), limits, NOW),
      ).toEqual({ ok: true });
    });

    it('limits simultaneous holds and active bookings per agent', async () => {
      const store = await factory();
      const limits = { agent_holds: 2, agent_active: 3 };
      const bot = (over: Partial<GuardEntry> = {}) =>
        entry({ agent_key: 'mcp:bot', guest_keys: [`e:${++seq}`], ...over });
      await store.claim(bot(), limits, NOW);
      await store.claim(bot(), limits, NOW);
      expect(await store.claim(bot(), limits, NOW)).toEqual({ ok: false, limit: 'agent_holds' });
      // Confirmed bookings are no longer holds, but still count as active.
      expect(
        await store.claim(bot({ status: 'confirmed', hold_expires_ms: null }), limits, NOW),
      ).toEqual({ ok: true });
      expect(
        await store.claim(bot({ status: 'confirmed', hold_expires_ms: null }), limits, NOW),
      ).toEqual({ ok: false, limit: 'agent_active' });
    });

    it('never lets concurrent claims slip past a limit', async () => {
      const store = await factory();
      const limits = { guest_venue: 3 };
      const results = await Promise.all(
        Array.from({ length: 12 }, () => store.claim(entry(), limits, NOW)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
    });

    it('never lets concurrent claims slip past an agent hold limit', async () => {
      const store = await factory();
      const limits = { agent_holds: 4 };
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          store.claim(entry({ agent_key: 'mcp:bot', guest_keys: [`e:c${i}`] }), limits, NOW),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(4);
    });

    it('updates an entry in place without counting it against itself, and keeps its flags', async () => {
      const store = await factory();
      const limits = { guest_venue: 1 };
      const e = entry({ agent_key: 'mcp:bot' });
      await store.claim(e, limits, NOW);
      await store.addFlags(e.booking_id, ['contact_many_names']);
      await store.addFlags(e.booking_id, ['contact_many_names', 'agent_many_names']);
      const confirmed = {
        ...e,
        status: 'confirmed' as const,
        hold_expires_ms: null,
        agent_key: null,
      };
      expect(await store.claim(confirmed, limits, NOW)).toEqual({ ok: true });
      const got = (await store.get(e.booking_id))!;
      expect(got.status).toBe('confirmed');
      expect(got.agent_key).toBe('mcp:bot');
      expect(got.flags.sort()).toEqual(['agent_many_names', 'contact_many_names']);
      expect(got.created_ms).toBe(T);
      expect([...(await store.flagsOf([e.booking_id, 'nope'])).keys()]).toEqual([e.booking_id]);
    });

    it('remembers what was cancelled from, for churn rules', async () => {
      const store = await factory();
      const a = entry({ status: 'confirmed', hold_expires_ms: null });
      const b = entry();
      await store.claim(a, {}, NOW);
      await store.claim(b, {}, NOW);
      await store.release(a.booking_id, new Date(T + 1000));
      await store.release(b.booking_id, new Date(T + 1000));
      expect((await store.get(a.booking_id))!).toMatchObject({
        status: 'cancelled',
        cancelled_from: 'confirmed',
        cancelled_ms: T + 1000,
      });
      expect((await store.get(b.booking_id))!.cancelled_from).toBe('held');
      const recent = await store.recent({ venue_id: 'v1', guest_keys: ['e:alice'] }, T);
      expect(recent.map((e) => e.booking_id).sort()).toEqual([a.booking_id, b.booking_id].sort());
      expect(await store.recent({ venue_id: 'v1', guest_keys: ['e:nobody'] }, T)).toEqual([]);
    });

    it('purges what ended long ago', async () => {
      const store = await factory();
      const old = entry({ start_ms: T - 90 * 24 * HOUR });
      const fresh = entry();
      await store.claim(old, {}, new Date(T - 91 * 24 * HOUR));
      await store.claim(fresh, {}, NOW);
      expect(await store.purge?.(T - 30 * 24 * HOUR)).toBe(1);
      expect(await store.get(old.booking_id)).toBeUndefined();
      expect(await store.get(fresh.booking_id)).toBeDefined();
    });
  });
}
