/**
 * The conformance suite, joined tables included, against the Postgres store (PGlite by default,
 * a real server with TEST_DATABASE_URL). The same venue and options as the memory run in
 * packages/conformance, so both stores are held to the same rules.
 */
import { describeProviderConformance } from '@openbooking-sh/conformance/vitest';
import { MemoryBookingProvider } from '@openbooking-sh/provider-memory';
import { conformanceRun, conformanceVenue } from '../../provider-memory/test/conformance-venue';
import { PostgresBookingStore } from '../src';
import { freshDb, target } from './helpers';

describeProviderConformance(`MemoryBookingProvider on Postgres (${target}, joined tables)`, {
  create: async () =>
    new MemoryBookingProvider(
      { name: 'Conformance Bistro', venues: [conformanceVenue()] },
      { store: new PostgresBookingStore(await freshDb()) },
    ),
  ...conformanceRun,
});
