/** Injectable time source so hold expiry and cancellation windows are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A manually advanced clock for tests and benchmarks. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(start: Date | string | number = Date.now()) {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  set(to: Date | string | number): void {
    this.#ms = new Date(to).getTime();
  }

  advance(ms: number): void {
    this.#ms += ms;
  }

  advanceSeconds(s: number): void {
    this.advance(s * 1000);
  }
}
