/**
 * Tiny deterministic fuzz kit (no dependencies). Every run is driven by a seed, and a failure
 * prints the seed, so `FUZZ_SEED=<n> pnpm vitest run <file>` replays exactly that case.
 *
 *   FUZZ_RUNS=500   how many seeds to try (each suite has its own small default)
 *   FUZZ_SEED=1234  run only this seed
 */

/** mulberry32: 32 bits of state, good enough for test inputs, identical on every platform. */
export class Rng {
  #s: number;

  constructor(seed: number) {
    this.#s = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) >>> 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** The seeds to run: FUZZ_SEED alone, else 1..FUZZ_RUNS (default `defaultRuns`). */
export function seeds(defaultRuns: number): number[] {
  const one = process.env.FUZZ_SEED;
  if (one) return [Number(one)];
  const runs = Number(process.env.FUZZ_RUNS) || defaultRuns;
  return Array.from({ length: runs }, (_, i) => i + 1);
}

/** Run `fn` for every seed; a failure is rethrown with the seed (and context) in the message. */
export async function forEachSeed(
  defaultRuns: number,
  fn: (rng: Rng, seed: number) => Promise<void> | void,
  label = '',
): Promise<void> {
  for (const seed of seeds(defaultRuns)) {
    try {
      await fn(new Rng(seed), seed);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      err.message = `[fuzz seed=${seed}${label ? ` ${label}` : ''}; replay with FUZZ_SEED=${seed}] ${err.message}`;
      throw err;
    }
  }
}

/** Yield to the event loop `n` microtask turns, so seeded operations interleave differently. */
export async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Vitest timeout for a fuzz test: generous, since FUZZ_RUNS can raise the work a lot. */
export const FUZZ_TIMEOUT = 600_000;
