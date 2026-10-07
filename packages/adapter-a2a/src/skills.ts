import { BookingError, type BookingService } from '@openbooking-sh/core';

export const SKILL_IDS = [
  'get_business_info',
  'search_availability',
  'hold_slot',
  'confirm_booking',
  'get_booking',
  'cancel_booking',
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

type Args = Record<string, unknown>;
type Handler = (service: BookingService, args: Args) => Promise<Record<string, unknown>>;

/** JSON round-trip so Dates and class instances become plain data. */
const plain = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v));

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function requireString(args: Args, key: string): string {
  const v = str(args[key]);
  if (!v) throw new BookingError('validation_error', `${key} is required.`);
  return v;
}

/**
 * Skill handlers map the flat A2A input onto BookingService. Input validation (dates, ids,
 * idempotency keys, user_confirmed) happens inside the service, so every protocol shares it.
 */
export const SKILL_HANDLERS: Record<SkillId, Handler> = {
  async get_business_info(service, args) {
    const venue = await service.resolveVenue(str(args.venue_id));
    const [services, resources, hours] = await Promise.all([
      service.listOfferings(venue.id),
      service.listResources(venue.id),
      service.getVenueInfo(venue.id),
    ]);
    return plain({
      venue,
      services,
      resources,
      opening_hours: hours,
      next_step: 'Pick a service, then call search_availability with offering_id and a date.',
    });
  },

  async search_availability(service, args) {
    const preferences = Array.isArray(args.preferences)
      ? args.preferences.filter((t): t is string => typeof t === 'string')
      : [];
    const tags = [...(str(args.staff) ? [str(args.staff)!] : []), ...preferences];
    const { venue, slots } = await service.searchAvailability({
      date: requireString(args, 'date'),
      party_size: { total: typeof args.party_size === 'number' ? args.party_size : 1 },
      ...(str(args.venue_id) ? { venue_id: str(args.venue_id)! } : {}),
      ...(str(args.time_from) ? { time_from: str(args.time_from)! } : {}),
      ...(str(args.time_to) ? { time_to: str(args.time_to)! } : {}),
      ...(str(args.offering_id) ? { offering_id: str(args.offering_id)! } : {}),
      ...(tags.length ? { tags } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    });
    return plain({
      venue,
      slots,
      next_step: slots.length
        ? 'Offer the user a few options. When they pick one, call hold_slot with its slot_id.'
        : 'No free slots. Suggest another date or a wider time window.',
    });
  },

  async hold_slot(service, args) {
    return bookingResult(await service.hold(args as never));
  },

  async confirm_booking(service, args) {
    return bookingResult(await service.confirm(args as never));
  },

  async get_booking(service, args) {
    return bookingResult(await service.getBooking(requireString(args, 'booking_id')));
  },

  async cancel_booking(service, args) {
    return bookingResult((await service.cancel(args as never)).booking);
  },
};

const NEXT_STEP: Record<string, string> = {
  held: 'Show the user the details, price, deposit and cancellation policy. After explicit approval call confirm_booking with user_confirmed=true before expires_at.',
  confirmed: 'Booking confirmed. Give the user the confirmation_code.',
  cancelled: 'Booking cancelled.',
  expired: 'The hold expired. Search and hold again.',
};

function bookingResult(booking: { status: string }): Record<string, unknown> {
  return plain({ booking, next_step: NEXT_STEP[booking.status] ?? '' });
}
