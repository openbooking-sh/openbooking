import {
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking-sh/provider-memory';
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
