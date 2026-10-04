export { MemoryBookingProvider, encodeSlotId, type MemoryProviderOptions } from './provider';
export {
  MemoryBookingStore,
  applyExpiry,
  isBlocking,
  lostSlot,
  type BookingRecord,
  type BookingRecordStore,
  type BookingListQuery,
} from './store';
export { demoRestaurantConfig, demoRestaurantVenue } from './seed';
export { demoSalonConfig, demoSalonVenue } from './salon';
export type * from './config';

import { MemoryBookingProvider, type MemoryProviderOptions } from './provider';
import { demoSalonConfig } from './salon';
import { demoRestaurantConfig } from './seed';

/** Ready-to-use provider for the fictional "Demo Bistro Oslo" restaurant. */
export function createDemoRestaurantProvider(
  options: MemoryProviderOptions = {},
): MemoryBookingProvider {
  return new MemoryBookingProvider(demoRestaurantConfig(), options);
}

/** Ready-to-use provider for the fictional "Studio Nord" hair salon. */
export function createDemoSalonProvider(
  options: MemoryProviderOptions = {},
): MemoryBookingProvider {
  return new MemoryBookingProvider(demoSalonConfig(), options);
}
