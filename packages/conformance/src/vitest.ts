/**
 * The vitest adapter: `import { describeProviderConformance } from '@openbooking-sh/conformance/vitest'`.
 * Lives in its own entry point so the main one never imports vitest.
 */
import { describe, it } from 'vitest';
import { conformanceChecks, type ConformanceOptions } from './index';

/** Registers every check as a vitest test, inside one `describe`. */
export function describeProviderConformance(name: string, options: ConformanceOptions): void {
  describe(`BookingProvider conformance: ${name}`, () => {
    for (const check of conformanceChecks(options)) {
      if (check.skipped) it.skip(check.name, check.run);
      else it(check.name, check.run);
    }
  });
}
