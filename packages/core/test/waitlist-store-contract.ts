/**
 * Behaviour every WaitlistStore must have. Run with `describeWaitlistStore(name, factory)`; used
 * for the memory store here and for the Postgres store in @openbooking-sh/postgres.
 */
import { describe, expect, it } from 'vitest';
import type { WaitlistEntry, WaitlistStore } from '../src';

const T0 = Date.parse('2030-06-01T10:00:00Z');
const at = (ms = 0) => new Date(T0 + ms).toISOString();

let seq = 0;
export function entry(over: Partial<WaitlistEntry> = {}): WaitlistEntry {
  const n = ++seq;
  return {
    waitlist_id: `wl_test_${n}`,
    venue_id: 'v1',
    offering_id: null,
    date: '2030-06-10',
    time_from: null,
    time_to: null,
    party_size: 2,
    customer: { first_name: 'Ada', last_name: 'Lovelace', email: `ada${n}@example.com` },
    status: 'waiting',
    created_at: at(n),
    updated_at: at(n),
    expires_at: '2030-06-11T00:00:00+00:00',
    consent: {
      user_confirmed: true,
      at: at(n),
      agent: 'Claude',
      purpose: 'offer_notification_and_hold',
    },
    offer: null,
    ...over,
  };
}

const OFFER = { offered_at: at(1000), expires_at: at(2000) };

export function describeWaitlistStore(name: string, make: () => Promise<WaitlistStore>): void {
  describe(`WaitlistStore: ${name}`, () => {
    it('lists oldest first, filtered by venue, date and status', async () => {
      const store = await make();
      const a = entry();
      const b = entry({ date: '2030-06-11' });
      const c = entry({ venue_id: 'v2' });
      const d = entry();
      for (const e of [a, b, c, d]) await store.insert(e);
      expect(
        (await store.list({ venue_id: 'v1', date: '2030-06-10' })).map((e) => e.waitlist_id),
      ).toEqual([a.waitlist_id, d.waitlist_id]);
      expect(await store.list({ venue_id: 'v2' })).toHaveLength(1);
      await store.transition(a.waitlist_id, ['waiting'], 'cancelled', at(5));
      expect(
        (await store.list({ venue_id: 'v1', date: '2030-06-10', status: ['waiting'] })).map(
          (e) => e.waitlist_id,
        ),
      ).toEqual([d.waitlist_id]);
      expect(await store.list({ limit: 2 })).toHaveLength(2);
      expect(await store.get('nope')).toBeUndefined();
      expect(await store.get(b.waitlist_id)).toEqual(b);
    });

    it('refuses the same id twice', async () => {
      const store = await make();
      const e = entry();
      await store.insert(e);
      await expect(store.insert(e)).rejects.toThrow();
    });

    it('hands a claim to one caller of many, and gives it back unchanged', async () => {
      const store = await make();
      const e = entry();
      await store.insert(e);
      const wins = await Promise.all(
        Array.from({ length: 8 }, () => store.claim(e.waitlist_id, OFFER, at(1000))),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(wins.find(Boolean)).toMatchObject({
        status: 'offered',
        offer: { booking_id: null, ...OFFER },
      });

      // A claim without a hold can be released, and the entry keeps its place.
      expect(await store.release(e.waitlist_id, at(1500))).toMatchObject({
        status: 'waiting',
        offer: null,
      });
      expect(await store.release(e.waitlist_id, at(1500))).toBeUndefined();
      expect((await store.list({ status: ['waiting'] }))[0]!.waitlist_id).toBe(e.waitlist_id);
    });

    it('attaches one hold to a claim, then finds the entry by it', async () => {
      const store = await make();
      const e = entry();
      await store.insert(e);
      expect(
        await store.attachOffer(e.waitlist_id, { booking_id: 'bk_1', expires_at: at(3000) }, at(1)),
      ).toBeUndefined(); // not claimed yet
      await store.claim(e.waitlist_id, OFFER, at(1000));
      const attached = await store.attachOffer(
        e.waitlist_id,
        { booking_id: 'bk_1', expires_at: at(3000) },
        at(1100),
      );
      expect(attached?.offer).toEqual({ booking_id: 'bk_1', ...OFFER, expires_at: at(3000) });
      // One hold per claim: a second attach, and a release of a claim with a hold, do nothing.
      expect(
        await store.attachOffer(e.waitlist_id, { booking_id: 'bk_2', expires_at: at(3000) }, at(2)),
      ).toBeUndefined();
      expect(await store.release(e.waitlist_id, at(3))).toBeUndefined();
      expect((await store.findByOffer('bk_1'))?.waitlist_id).toBe(e.waitlist_id);
      expect(await store.findByOffer('bk_other')).toBeUndefined();
    });

    it('moves status only from the expected one, once', async () => {
      const store = await make();
      const e = entry();
      await store.insert(e);
      await store.claim(e.waitlist_id, OFFER, at(1000));
      const results = await Promise.all([
        store.transition(e.waitlist_id, ['offered'], 'accepted', at(2000)),
        store.transition(e.waitlist_id, ['offered'], 'declined', at(2000)),
        store.transition(e.waitlist_id, ['waiting'], 'cancelled', at(2000)),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.get(e.waitlist_id))?.status).toBe(results.find(Boolean)!.status);
    });

    it('finds and erases a customer by email or phone, within one venue when asked', async () => {
      const store = await make();
      const ada = {
        first_name: 'Ada',
        last_name: 'L',
        email: 'Ada@Example.com',
        phone_number: '+47 123 45 678',
      };
      const mine = entry({ customer: ada });
      const mineElsewhere = entry({ customer: ada, venue_id: 'v2' });
      const phoneOnly = entry({
        customer: { first_name: 'A', last_name: 'L', phone_number: '+4712345678' },
      });
      const other = entry({
        customer: { first_name: 'B', last_name: 'B', email: 'b@example.com' },
      });
      for (const e of [mine, mineElsewhere, phoneOnly, other]) await store.insert(e);

      expect(
        (await store.forCustomer({ email: 'ada@example.com' })).map((e) => e.waitlist_id),
      ).toEqual([mine.waitlist_id, mineElsewhere.waitlist_id]);
      // Phone numbers match by digits, so spacing does not matter.
      expect((await store.forCustomer({ phone: '4712345678' })).map((e) => e.waitlist_id)).toEqual([
        mine.waitlist_id,
        mineElsewhere.waitlist_id,
        phoneOnly.waitlist_id,
      ]);
      // Too few digits never matches (an empty-ish number must not erase everyone).
      expect(await store.forCustomer({ phone: '12' })).toEqual([]);
      expect(await store.eraseCustomer({ phone: '12' })).toBe(0);

      expect(await store.eraseCustomer({ email: 'ADA@example.com' }, 'v1')).toBe(1);
      expect(await store.get(mine.waitlist_id)).toBeUndefined();
      expect(await store.get(mineElsewhere.waitlist_id)).toBeDefined();
      expect(await store.eraseCustomer({ email: 'ada@example.com', phone: '4712345678' })).toBe(2);
      expect((await store.list()).map((e) => e.waitlist_id)).toEqual([other.waitlist_id]);
    });

    it('deletes a venue, and purges only finished entries older than the cutoff', async () => {
      const store = await make();
      const oldDone = entry();
      const newDone = entry();
      const oldWaiting = entry();
      const otherVenue = entry({ venue_id: 'v9' });
      for (const e of [oldDone, newDone, oldWaiting, otherVenue]) await store.insert(e);
      await store.transition(oldDone.waitlist_id, ['waiting'], 'expired', at(-10_000));
      await store.transition(newDone.waitlist_id, ['waiting'], 'expired', at(10_000));

      expect(await store.purge(at(0))).toBe(1);
      expect(await store.get(oldDone.waitlist_id)).toBeUndefined();
      expect(await store.get(newDone.waitlist_id)).toBeDefined();
      expect(await store.get(oldWaiting.waitlist_id)).toBeDefined(); // still waiting: never purged

      expect(await store.deleteVenue('v1')).toBe(2);
      expect((await store.list()).map((e) => e.waitlist_id)).toEqual([otherVenue.waitlist_id]);
    });
  });
}
