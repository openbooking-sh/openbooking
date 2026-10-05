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
  CancelBookingInput,
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
  'search_availability',
  'hold_slot',
  'confirm_booking',
  'get_booking',
  'cancel_booking',
] as const;

export const BASE_INSTRUCTIONS = `Book tables/appointments with this booking system.
Flow: search_availability → hold_slot → (show the user the details and get explicit approval) → confirm_booking.
Rules:
- A hold reserves the slot only until expires_at. Confirm before then, or search again.
- Always show the user the price, deposit and cancellation_policy before confirming.
- Set user_confirmed=true only after the user explicitly approves. Never confirm on your own.
- Every mutating call needs an idempotency_key (UUID). Reuse the same key when retrying the same call; use a new key for a new action.
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

/** Build an McpServer exposing the five OpenBooking tools on top of a BookingService. */
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
 * Register the five booking tools on `server`. `createMcpServer` does this for one business; a
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

  const search = scope(SearchAvailabilityInput);
  server.registerTool(
    'search_availability',
    {
      title: 'Search availability',
      description:
        'Find bookable time slots for a date and party size. Returns slot_ids with price, deposit and cancellation policy. Slots are NOT reserved until you call hold_slot. Narrow with time_from/time_to (venue local time).' +
        forBusiness,
      inputSchema: advertised(search),
      outputSchema: SearchAvailabilityOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(search, async (a) => {
      const service = await resolve(a.business_id);
      const { venue, slots } = await service.searchAvailability({
        date: a.date,
        party_size: { total: a.party_size },
        ...(a.venue_id ? { venue_id: a.venue_id } : {}),
        ...(a.time_from ? { time_from: a.time_from } : {}),
        ...(a.time_to ? { time_to: a.time_to } : {}),
        ...(a.offering_id ? { offering_id: a.offering_id } : {}),
        ...(a.preferences?.length ? { tags: a.preferences } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
      });
      return {
        venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
        date: a.date,
        party_size: a.party_size,
        slots: slots.map((s) => slotView(s, venue)),
        next_step: slots.length
          ? 'Offer the user a few options. When they pick one, call hold_slot with its slot_id.'
          : 'No availability. Suggest another date, a wider time window, or fewer preferences.',
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
    ...(s.resource ? { resource: [s.resource.label, ...s.resource.tags].join(', ') } : {}),
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
        `Show the user: ${b.slot.offering.name} at ${b.slot.start} for ${b.slot.party_size.total}` +
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
