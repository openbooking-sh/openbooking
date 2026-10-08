import { describeProviderConformance } from '@openbooking-sh/conformance/vitest';
import { CalcomBookingProvider } from '../src';
import { createFakeCal } from './fake-cal';

describeProviderConformance('CalcomBookingProvider (fake Cal.com API)', {
  create: () =>
    new CalcomBookingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://cal.test',
      fetch: createFakeCal().fetch,
      venue: { id: 'studio-nord', name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
    }),
  now: new Date('2026-10-01T06:00:00Z'),
  query: { date: '2026-10-02', party_size: { total: 1 }, offering_id: '11' },
  skip: {
    // Real Cal.com frees a slot reservation when its duration ends; the fake never does.
    'expiry > stops blocking a full slot once its holds have expired':
      'the fake Cal.com API does not expire reservations',
  },
});
