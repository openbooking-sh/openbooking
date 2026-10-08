/**
 * The few assertions the suite needs, on `node:assert`. Keeping them here means the main entry
 * point imports no test runner, so `runProviderConformance()` works anywhere and the vitest
 * adapter is the only part that needs vitest.
 */
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

const show = (v: unknown) => inspect(v, { depth: 4, breakLength: 100 });

/** True when every key of `subset` appears in `actual` with a matching value, recursively. */
function matchesSubset(actual: unknown, subset: unknown): boolean {
  if (subset === null || typeof subset !== 'object') return Object.is(actual, subset);
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(subset).every(([k, v]) =>
    matchesSubset((actual as Record<string, unknown>)[k], v),
  );
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: string) =>
    assert.ok(negate ? !pass : pass, `${negate ? 'Did not expect' : 'Expected'} ${message}`);
  return {
    toBe: (expected: unknown) =>
      check(Object.is(actual, expected), `${show(actual)} to be ${show(expected)}`),
    toBeNull: () => check(actual === null, `${show(actual)} to be null`),
    toBeGreaterThan: (n: number) =>
      check((actual as number) > n, `${show(actual)} to be greater than ${n}`),
    toMatch: (re: RegExp) => check(re.test(String(actual)), `${show(actual)} to match ${re}`),
    toHaveLength: (n: number) =>
      check(
        (actual as { length: number }).length === n,
        `length ${(actual as unknown[]).length} to be ${n}`,
      ),
    toContain: (item: unknown) =>
      check((actual as unknown[]).includes(item), `${show(actual)} to contain ${show(item)}`),
    toEqual: (expected: unknown) => {
      let equal = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        equal = false;
      }
      check(equal, `${show(actual)} to equal ${show(expected)}`);
    },
    toMatchObject: (subset: unknown) =>
      check(matchesSubset(actual, subset), `${show(actual)} to match ${show(subset)}`),
  };
}

export function expect(actual: unknown) {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    /** For a promise: waits for it, then applies the matcher to what it resolved to. */
    resolves: new Proxy({} as ReturnType<typeof matchers>, {
      get:
        (_t, name: keyof ReturnType<typeof matchers>) =>
        async (...args: unknown[]) =>
          (matchers(await actual, false)[name] as (...a: unknown[]) => void)(...args),
    }),
  };
}
