import {
  MemoryBookingProvider,
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking-sh/provider-memory';
import { conformanceRun, conformanceVenue } from '../../provider-memory/test/conformance-venue';
import { describeProviderConformance } from '../src/vitest';

// Thursday 2026-10-01 10:00 Oslo time; the next day is open in both demos.
const NOW = new Date('2026-10-01T08:00:00Z');

describeProviderConformance('MemoryBookingProvider (demo restaurant)', {
  create: () => createDemoRestaurantProvider(),
  now: NOW,
  query: { date: '2026-10-02', party_size: { total: 2 }, offering_id: 'dinner' },
});

describeProviderConformance('MemoryBookingProvider (demo salon)', {
  create: () => createDemoSalonProvider(),
  now: NOW,
  query: { date: '2026-10-02', party_size: { total: 1 } },
});

// Opt-in: tables pushed together are claimed, freed and never shared as one unit.
describeProviderConformance('MemoryBookingProvider (joined tables)', {
  create: () =>
    new MemoryBookingProvider({ name: 'Conformance Bistro', venues: [conformanceVenue()] }),
  ...conformanceRun,
});
