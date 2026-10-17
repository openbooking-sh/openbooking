/**
 * Behaviour every SuppressionList must have. Run with `describeSuppressionList(name, factory)`;
 * used for the memory list here and for the Postgres list in @openbooking-sh/postgres.
 */
import { describe, expect, it } from 'vitest';
import { suppressionHash, type SuppressionList } from '../src';

export function describeSuppressionList(name: string, make: () => Promise<SuppressionList>) {
  describe(`SuppressionList: ${name}`, () => {
    it('knows only what was added, per business', async () => {
      const list = await make();
      const ada = suppressionHash('a', 'ada@example.com');
      expect(await list.has('a', ada)).toBe(false);
      await list.add('a', ada);
      expect(await list.has('a', ada)).toBe(true);
      // The same address at another business is a different record.
      expect(await list.has('b', suppressionHash('b', 'ada@example.com'))).toBe(false);
      expect(await list.has('b', ada)).toBe(false);
    });

    it('adding twice is fine, also at the same time', async () => {
      const list = await make();
      const h = suppressionHash('a', 'ada@example.com');
      await Promise.all([list.add('a', h), list.add('a', h), list.add('a', h)]);
      await list.add('a', h);
      expect(await list.has('a', h)).toBe(true);
    });

    it('forgets one business and nothing else', async () => {
      const list = await make();
      await list.add('a', suppressionHash('a', 'x@example.com'));
      await list.add('b', suppressionHash('b', 'x@example.com'));
      await list.deleteScope('a');
      expect(await list.has('a', suppressionHash('a', 'x@example.com'))).toBe(false);
      expect(await list.has('b', suppressionHash('b', 'x@example.com'))).toBe(true);
    });
  });
}

describe('suppressionHash', () => {
  it('ignores case and padding, differs per business and never contains the address', () => {
    const h = suppressionHash('a', 'Ada@Example.com ');
    expect(h).toBe(suppressionHash('a', 'ada@example.com'));
    expect(h).not.toBe(suppressionHash('b', 'ada@example.com'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('ada');
  });
});
