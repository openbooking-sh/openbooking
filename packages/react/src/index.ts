export { BookingWidget, type BookingWidgetProps } from './BookingWidget';
export {
  OpenBookingProvider,
  useOpenBookingClient,
  type OpenBookingProviderProps,
} from './context';
export {
  useAvailability,
  useBooking,
  useInfo,
  type FlowStatus,
  type Loaded,
  type UseBooking,
} from './hooks';
export { formatClock, formatMoney, formatSlotTime } from './format';
// The client's types and error, so a page needs one import.
export { createClient, OpenBookingError, type OpenBookingClient } from '@openbooking-sh/client';
export type * from '@openbooking-sh/client';
