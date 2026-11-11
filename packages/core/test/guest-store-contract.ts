import { describe, expect, it } from 'vitest';
import type { GuestProfile, GuestStore } from '../src';

const profile = (over: Partial<GuestProfile> = {}): GuestProfile => ({
  tags: ['window'],
  notes: 'likes the corner table',
  vip: true,
  updated_at: '2026-10-01T08:00:00.000Z',
  ...over,
});

/** What every GuestStore must do. Run it against each implementation. */
export function describeGuestStore(name: string, make: () => Promise<GuestStore>) {
  describe(`GuestStore: ${name}`, () => {
    it('keeps dietary notes per booking, and replaces them', async () => {
      const s = await make();
      await s.saveDietaryNote({
        venue_id: 'a',
        booking_id: 'bk1',
        note: 'peanuts',
        visit_end: '2026-10-10T20:00:00.000Z',
      });
      await s.saveDietaryNote({
        venue_id: 'a',
        booking_id: 'bk1',
        note: 'peanuts and sesame',
        visit_end: '2026-10-10T20:00:00.000Z',
      });
      expect([...(await s.dietaryNotes('a', ['bk1', 'bk2']))]).toEqual([
        ['bk1', 'peanuts and sesame'],
      ]);
      expect(await s.deleteDietaryNotes('a', ['bk1'])).toBe(1);
      expect((await s.dietaryNotes('a', ['bk1'])).size).toBe(0);
    });

    it('purges notes whose visit ended before the cutoff, for one venue or all', async () => {
      const s = await make();
      const note = (venue_id: string, booking_id: string, visit_end: string) =>
        s.saveDietaryNote({ venue_id, booking_id, note: 'x', visit_end });
      await note('a', 'old', '2026-10-01T20:00:00.000Z');
      await note('a', 'new', '2026-10-09T20:00:00.000Z');
      await note('b', 'old', '2026-10-01T20:00:00.000Z');
      const cutoff = new Date('2026-10-05T00:00:00.000Z');
      expect(await s.purgeDietaryNotes(cutoff, 'a')).toBe(1);
      expect((await s.dietaryNotes('a', ['old', 'new'])).has('new')).toBe(true);
      expect((await s.dietaryNotes('b', ['old'])).has('old')).toBe(true);
      expect(await s.purgeDietaryNotes(cutoff)).toBe(1);
      expect((await s.dietaryNotes('b', ['old'])).size).toBe(0);
    });

    it('never shows one business the data of another', async () => {
      const s = await make();
      await s.saveDietaryNote({
        venue_id: 'a',
        booking_id: 'bk1',
        note: 'shellfish',
        visit_end: '2026-10-10T20:00:00.000Z',
      });
      await s.saveProfile('a', 'key1', profile());
      expect((await s.dietaryNotes('b', ['bk1'])).size).toBe(0);
      expect((await s.profiles('b', ['key1'])).size).toBe(0);
      expect((await s.listProfiles('b')).size).toBe(0);
      expect(await s.deleteProfiles('b', ['key1'])).toBe(0);
      expect(await s.deleteDietaryNotes('b', ['bk1'])).toBe(0);
      expect((await s.profiles('a', ['key1'])).get('key1')).toEqual(profile());
    });

    it('saves, lists and deletes profiles', async () => {
      const s = await make();
      await s.saveProfile('a', 'k1', profile());
      await s.saveProfile('a', 'k1', profile({ vip: false, tags: [] }));
      await s.saveProfile('a', 'k2', profile());
      expect((await s.profiles('a', ['k1'])).get('k1')).toMatchObject({ vip: false, tags: [] });
      expect([...(await s.listProfiles('a')).keys()].sort()).toEqual(['k1', 'k2']);
      expect(await s.deleteProfiles('a', ['k1', 'nope'])).toBe(1);
      expect([...(await s.listProfiles('a')).keys()]).toEqual(['k2']);
    });

    it('deletes everything of a business and nothing else', async () => {
      const s = await make();
      for (const v of ['a', 'b']) {
        await s.saveProfile(v, 'k', profile());
        await s.saveDietaryNote({
          venue_id: v,
          booking_id: 'bk',
          note: 'n',
          visit_end: '2026-10-10T20:00:00.000Z',
        });
      }
      await s.deleteVenue('a');
      expect((await s.listProfiles('a')).size).toBe(0);
      expect((await s.dietaryNotes('a', ['bk'])).size).toBe(0);
      expect((await s.listProfiles('b')).size).toBe(1);
      expect((await s.dietaryNotes('b', ['bk'])).size).toBe(1);
    });
  });
}
