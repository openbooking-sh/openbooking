import {
  BookingError,
  fromZodError,
  formatMoney,
  time,
  toErrorPayload,
  type Booking,
  type BookingService,
  type Slot,
  type Venue,
  type VenueInfo,
  WEEKDAYS,
} from '@openbooking-sh/core';
import {
  McpServer,
  createMcpHandler,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {
  BookingView,
  BusinessInfoOutput,
  GetBusinessInfoInput,
  CancelBookingInput,
  RescheduleBookingInput,
  ConfirmBookingInput,
  GetBookingInput,
  HoldSlotInput,
  SearchAvailabilityInput,
  SearchAvailabilityOutput,
} from './schemas';

export interface McpAdapterOptions {
  service: BookingService;
  /** Server name reported to MCP clients. Default "openbooking". */
  name?: string;
  version?: string;
  /** Extra text appended to the default server instructions (e.g. venue specifics). */
  instructions?: string;
}

export const TOOL_NAMES = [
  'get_business_info',
  'search_availability',
  'hold_slot',
  'confirm_booking',
  'get_booking',
  'reschedule_booking',
  'cancel_booking',
] as const;

export const BASE_INSTRUCTIONS = `Book appointments (or tables) with this business.
Flow: get_business_info (services, staff, opening hours) → search_availability → hold_slot → (show the user the details and get explicit approval) → confirm_booking.
- To book a specific person, pass staff (their name) to search_availability.
Rules:
- A hold reserves the slot only until expires_at. Confirm before then, or search again.
- Always show the user the price, deposit and cancellation_policy before confirming.
- Set user_confirmed=true only after the user explicitly approves. Never confirm on your own.
- Every mutating call needs an idempotency_key (UUID). Reuse the same key when retrying the same call; use a new key for a new action.
- To move a confirmed booking, search_availability for the same service, then reschedule_booking (it keeps the booking and its confirmation code). Don't cancel and rebook.
- Errors include suggested_next_action. Follow it.`;

/**
 * Wrap a zod schema so the MCP SDK advertises its JSON Schema to clients but does not reject
 * input itself. We validate inside the handler instead, so validation failures come back as our
 * structured `{ code, message, suggested_next_action }` errors rather than plain SDK text.
 */
function advertised<S extends z.ZodType>(schema: S): S {
  const std = schema['~standard'];
  return {
    '~standard': {
      ...std,
      jsonSchema: std.jsonSchema,
      validate: (value: unknown) => ({ value }),
    },
  } as unknown as S;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(e: unknown): ToolResult {
  const error = toErrorPayload(e);
  const data = { error };
  return {
    content: [
      {
        type: 'text',
        text: `Error ${error.code}: ${error.message}\nSuggested next action: ${error.suggested_next_action}\n${JSON.stringify(data)}`,
      },
    ],
    structuredContent: data,
    isError: true,
  };
}

function tool<S extends z.ZodType>(
  schema: S,
  fn: (args: z.output<S>) => Promise<Record<string, unknown>>,
) {
  return async (args: unknown): Promise<ToolResult> => {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) return fail(fromZodError(parsed.error, 'Invalid arguments'));
    try {
      return ok(await fn(parsed.data));
    } catch (e) {
      return fail(e);
    }
  };
}

/** Build an McpServer exposing the six OpenBooking tools on top of a BookingService. */
export function createMcpServer(options: McpAdapterOptions): McpServer {
  const { service } = options;
  const server = new McpServer(
    { name: options.name ?? 'openbooking', version: options.version ?? '0.1.0' },
    {
      instructions: options.instructions
        ? `${BASE_INSTRUCTIONS}\n\n${options.instructions}`
        : BASE_INSTRUCTIONS,
    },
  );
  registerBookingTools(server, { resolve: () => service });
  return server;
}

export interface BookingToolsOptions {
  /** The service a call runs against. One business: always the same one. */
  resolve: (args: { business_id?: string }) => BookingService | Promise<BookingService>;
  /**
   * Add a required `business_id` to every tool, for one MCP app serving many businesses. The
   * resolver turns it into that business's service (and throws `not_found` for unknown ids).
   */
  scoped?: boolean;
}

const BUSINESS_ID = z
  .string()
  .min(1)
  .describe('business_id from find_business. Required on every booking call.');

/**
 * Register the six booking tools on `server`. `createMcpServer` does this for one business; a
 * directory server registers them `scoped` next to its own discovery tools.
 */
export function registerBookingTools(server: McpServer, options: BookingToolsOptions): void {
  // Typed as optional so handlers compile for both cases; validation enforces it when scoped.
  const scope = <S extends z.ZodObject>(schema: S) =>
    (options.scoped
      ? schema.extend({ business_id: BUSINESS_ID })
      : schema) as unknown as z.ZodObject<S['shape'] & { business_id: z.ZodOptional<z.ZodString> }>;
  const forBusiness = options.scoped ? ' Pass the business_id from find_business.' : '';
  const resolve = (businessId: unknown) =>
    options.resolve(typeof businessId === 'string' ? { business_id: businessId } : {});

  const venueCache = new WeakMap<BookingService, Map<string, Venue>>();
  const venueOf = async (service: BookingService, id: string) => {
    let cache = venueCache.get(service);
    if (!cache) venueCache.set(service, (cache = new Map()));
    if (!cache.has(id)) for (const v of await service.listVenues()) cache.set(v.id, v);
    const v = cache.get(id);
    if (!v) throw new BookingError('not_found', `Unknown venue ${id}`);
    return v;
  };
  const view = async (service: BookingService, b: Booking) =>
    bookingView(b, await venueOf(service, b.venue_id), service.clock.now());

  const info = scope(GetBusinessInfoInput);
  server.registerTool(
    'get_business_info',
    {
      title: 'Get business info',
      description:
        'Services with duration and price, staff customers can ask for, opening hours and how far ahead bookings are accepted. Call this first to know what can be booked.' +
        forBusiness,
      inputSchema: advertised(info),
      outputSchema: BusinessInfoOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(info, async (a) => {
      const service = await resolve(a.business_id);
      const venue = await service.resolveVenue(a.venue_id);
      const [offerings, resources, hours] = await Promise.all([
        service.listOfferings(venue.id),
        service.listResources(venue.id),
        service.getVenueInfo(venue.id),
      ]);
      const addr = venue.address;
      return {
        venue: {
          id: venue.id,
          name: venue.name,
          description: venue.description ?? null,
          address: addr
            ? [
                addr.street_address,
                [addr.postal_code, addr.address_locality].filter(Boolean).join(' '),
              ]
                .filter(Boolean)
                .join(', ') || null
            : null,
          phone_number: venue.phone_number ?? null,
          timezone: venue.timezone,
          currency: venue.currency ?? null,
        },
        services: offerings.map((o) => ({
          id: o.id,
          name: o.name,
          description: o.description ?? null,
          duration_minutes: o.duration_minutes,
          price: o.price_per_person ?? null,
        })),
        staff: resources
          .filter((r) => r.capacity.max === 1 && r.kind !== 'table')
          .map((r) => r.name),
        staff_hours: Object.fromEntries(
          Object.entries(hours?.staff_hours ?? {}).flatMap(([id, week]) => {
            const person = resources.find((r) => r.id === id);
            return person ? [[person.name, periodsText(week, 'off')]] : [];
          }),
        ),
        opening_hours: hours ? hoursText(hours) : null,
        closed_dates: hours?.closed_dates ?? [],
        booking_window: hours
          ? { min_lead_minutes: hours.min_lead_minutes, max_days_ahead: hours.max_days_ahead }
          : null,
        next_step:
          'Help the user pick a service (and a staff member if they care), then call search_availability with offering_id and a date.',
      };
    }),
  );

  const search = scope(SearchAvailabilityInput);
  server.registerTool(
    'search_availability',
    {
      title: 'Search availability',
      description:
        'Find free times on a date. Returns slot_ids with who is booked, price, deposit and cancellation policy. Slots are NOT reserved until you call hold_slot. Narrow with offering_id, staff and time_from/time_to (venue local time).' +
        forBusiness,
      inputSchema: advertised(search),
      outputSchema: SearchAvailabilityOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(search, async (a) => {
      const service = await resolve(a.business_id);
      const tags = [...(a.staff ? [a.staff] : []), ...(a.preferences ?? [])];
      const { venue, slots } = await service.searchAvailability({
        date: a.date,
        party_size: { total: a.party_size },
        ...(a.venue_id ? { venue_id: a.venue_id } : {}),
        ...(a.time_from ? { time_from: a.time_from } : {}),
        ...(a.time_to ? { time_to: a.time_to } : {}),
        ...(a.offering_id ? { offering_id: a.offering_id } : {}),
        ...(tags.length ? { tags } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
      });
      return {
        venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
        date: a.date,
        party_size: a.party_size,
        slots: slots.map((s) => slotView(s, venue)),
        next_step: slots.length
          ? 'Offer the user a few options (mention who it is with). When they pick one, call hold_slot with its slot_id.'
          : await emptyReason(service, venue, a.date, !!a.staff),
      };
    }),
  );

  const hold = scope(HoldSlotInput);
  server.registerTool(
    'hold_slot',
    {
      title: 'Hold a slot',
      description:
        'Temporarily reserve a slot so nobody else can take it. The hold expires at expires_at (a few minutes). Returns the booking_id, the exact cancellation policy and deposit terms to show the user. This does NOT confirm the booking.' +
        forBusiness,
      inputSchema: advertised(hold),
      outputSchema: BookingView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(hold, async ({ business_id, ...a }) => {
      const service = await resolve(business_id);
      return view(service, await service.hold(a));
    }),
  );

  const confirm = scope(ConfirmBookingInput);
  server.registerTool(
    'confirm_booking',
    {
      title: 'Confirm booking',
      description:
        'Confirm a held booking. Only call after the user explicitly approved the details (time, party size, price, deposit, cancellation policy); pass user_confirmed=true. Requires customer details (here or on hold_slot) and a payment_token if a deposit is due at confirmation. Must be called before the hold expires.' +
        forBusiness,
      inputSchema: advertised(confirm),
      outputSchema: BookingView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(confirm, async ({ business_id, ...a }) => {
      const service = await resolve(business_id);
      return view(service, await service.confirm(a));
    }),
  );

  const get = scope(GetBookingInput);
  server.registerTool(
    'get_booking',
    {
      title: 'Get booking',
      description:
        'Look up the current status and details of a booking or hold by booking_id.' + forBusiness,
      inputSchema: advertised(get),
      outputSchema: BookingView,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(get, async ({ business_id, ...a }) => {
      const service = await resolve(business_id);
      return view(service, await service.getBooking(a.booking_id));
    }),
  );

  const reschedule = scope(RescheduleBookingInput);
  server.registerTool(
    'reschedule_booking',
    {
      title: 'Reschedule booking',
      description:
        'Move a confirmed booking to a new time (a slot_id from search_availability for the same service and party size). Keeps the booking id and confirmation code. Allowed while cancellation is still free. Show the user the new time, price and cancellation terms and pass user_confirmed=true after they approve.' +
        forBusiness,
      inputSchema: advertised(reschedule),
      outputSchema: BookingView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(reschedule, async ({ business_id, ...a }) => {
      const service = await resolve(business_id);
      return view(service, await service.reschedule(a));
    }),
  );

  const cancel = scope(CancelBookingInput);
  server.registerTool(
    'cancel_booking',
    {
      title: 'Cancel booking',
      description:
        'Release a hold, or cancel a confirmed booking. Cancelling a confirmed booking may cost a fee per the cancellation policy; the first call without user_confirmed returns the fee so you can ask the user, then call again with user_confirmed=true.' +
        forBusiness,
      inputSchema: advertised(cancel),
      outputSchema: BookingView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(cancel, async ({ business_id, ...a }) => {
      const service = await resolve(business_id);
      return view(service, (await service.cancel(a)).booking);
    }),
  );
}

/**
 * A stateless, web-standard (Request → Response) Streamable HTTP handler. Mount it in any
 * framework: `app.all('/mcp', (c) => handler.fetch(c.req.raw))`.
 */
export function createMcpHttpHandler(
  options: McpAdapterOptions,
  handlerOptions?: CreateMcpHandlerOptions,
): McpHttpHandler {
  return createMcpHandler(() => createMcpServer(options), handlerOptions);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** { mon: "closed", tue: "10:00-19:00", … } */
function hoursText(info: VenueInfo): Record<string, string> {
  return periodsText(info.opening_hours, 'closed');
}

function periodsText(week: VenueInfo['opening_hours'], none: string): Record<string, string> {
  return Object.fromEntries(
    WEEKDAYS.map((d) => {
      const periods = week[d] ?? [];
      return [d, periods.length ? periods.map((p) => `${p.open}-${p.close}`).join(', ') : none];
    }),
  );
}

/** Tell "closed that day" from "fully booked", so agents suggest the right thing. */
async function emptyReason(
  service: BookingService,
  venue: Venue,
  date: string,
  staffAsked: boolean,
): Promise<string> {
  const info = await service.getVenueInfo(venue.id).catch(() => null);
  if (info) {
    const weekday = DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
    const closed = info.closed_dates.includes(date) || !(info.opening_hours[weekday] ?? []).length;
    if (closed) {
      const open = Object.entries(hoursText(info))
        .filter(([, h]) => h !== 'closed')
        .map(([d, h]) => `${d} ${h}`)
        .join(', ');
      return `${venue.name} is closed on ${date}. Opening hours: ${open}. Suggest another day.`;
    }
  }
  return staffAsked
    ? 'Fully booked with that staff member on this date. Suggest another date, or search without staff for anyone free.'
    : 'Fully booked on this date. Suggest another date or a wider time window.';
}

/** The label plus tags that aren't just the name. */
function resourceText(r: NonNullable<Slot['resource']>): string {
  const extra = r.tags.filter((t) => t.toLowerCase() !== r.label.toLowerCase() && t !== r.id);
  if (!extra.length) return r.label;
  // People read as "Maria (color, senior)", tables as "Table for up to 4, outdoor".
  return r.kind === 'table' ? [r.label, ...extra].join(', ') : `${r.label} (${extra.join(', ')})`;
}

function slotView(
  s: Slot,
  venue: Venue,
): z.input<typeof SearchAvailabilityOutput>['slots'][number] {
  return {
    slot_id: s.slot_id,
    start: s.start,
    end: s.end,
    local_time: time.localTime(new Date(s.start), venue.timezone),
    offering: s.offering,
    ...(s.resource ? { resource: resourceText(s.resource) } : {}),
    ...(s.also_available?.length ? { also_available: s.also_available } : {}),
    price: s.price,
    deposit: s.deposit,
    cancellation_policy: s.cancellation_policy,
  };
}

export function bookingView(b: Booking, venue: Venue, now: Date): z.input<typeof BookingView> {
  const start = new Date(b.slot.start);
  const expiresIn =
    b.status === 'held' && b.expires_at
      ? Math.max(0, Math.floor((new Date(b.expires_at).getTime() - now.getTime()) / 1000))
      : null;
  return {
    booking_id: b.booking_id,
    status: b.status,
    venue: { id: venue.id, name: venue.name },
    start: b.slot.start,
    end: b.slot.end,
    local_date: time.localDate(start, venue.timezone),
    local_time: time.localTime(start, venue.timezone),
    party_size: b.slot.party_size.total,
    offering: b.slot.offering,
    resource: b.slot.resource?.label ?? null,
    customer: b.customer,
    notes: b.notes,
    price: b.slot.price,
    deposit: b.slot.deposit,
    cancellation_policy: b.slot.cancellation_policy,
    expires_at: b.status === 'held' ? b.expires_at : null,
    expires_in_seconds: expiresIn,
    confirmation_code: b.confirmation_code,
    payment_status: b.payment.status,
    cancellation: b.cancellation,
    next_step: nextStep(b, expiresIn),
  };
}

function nextStep(b: Booking, expiresIn: number | null): string {
  switch (b.status) {
    case 'held': {
      const steps = [
        `Slot held until ${b.expires_at} (${expiresIn}s left). It is NOT booked yet.`,
        `Show the user: ${b.slot.offering.name} at ${b.slot.start}` +
          (b.slot.resource ? ` with ${b.slot.resource.label}` : '') +
          (b.slot.party_size.total > 1 ? ` for ${b.slot.party_size.total}` : '') +
          (b.slot.price ? `, price ${formatMoney(b.slot.price)}` : '') +
          (b.slot.deposit
            ? `, deposit ${formatMoney(b.slot.deposit.amount)} (${b.slot.deposit.due})`
            : '') +
          `, cancellation: "${b.slot.cancellation_policy.description}"`,
      ];
      if (!b.customer) steps.push('Collect first name, last name and email or phone number.');
      if (b.slot.deposit?.due === 'at_confirmation')
        steps.push('Obtain a payment_token for the deposit.');
      steps.push(
        'After the user explicitly approves, call confirm_booking with user_confirmed=true.',
      );
      return steps.join(' ');
    }
    case 'confirmed':
      return `Booking confirmed. Give the user confirmation code ${b.confirmation_code} and remind them of the cancellation policy.`;
    case 'cancelled':
      return b.cancellation?.fee
        ? `Cancelled. A fee of ${formatMoney(b.cancellation.fee)} applies.`
        : 'Cancelled. No fee.';
    case 'expired':
      return 'The hold expired and the slot was released. Call search_availability and hold_slot again.';
  }
}
