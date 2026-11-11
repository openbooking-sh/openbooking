/**
 * Waitlist tools: `join_waitlist`, `check_waitlist`, `leave_waitlist`. Registered only when the
 * server is given a core `Waitlist`, so a business that does not want one exposes nothing new.
 */
import {
  BookingError,
  CancellationPolicySchema,
  CustomerSchema,
  DateSchema,
  DepositTermsSchema,
  IdempotencyKeySchema,
  LocalTimeSchema,
  MoneySchema,
  WaitlistStatusSchema,
  fromZodError,
  formatMoney,
  time,
  toErrorPayload,
  type Booking,
  type Venue,
  type Waitlist,
  type WaitlistEntry,
} from '@openbooking-sh/core';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export const WAITLIST_TOOL_NAMES = ['join_waitlist', 'check_waitlist', 'leave_waitlist'] as const;

/** Appended to the server instructions when the waitlist is on. */
export const WAITLIST_INSTRUCTIONS = `Waitlist: if search_availability finds nothing and the user wants to be told when something opens up, use join_waitlist (never when slots exist: book them). Joining needs their explicit agreement (user_confirmed=true) and an email address: when a time frees up we hold it for them for a short while and email them. Nothing is booked for them: to take a held slot, show them the details and, after they approve, call confirm_booking with the booking_id from check_waitlist. check_waitlist shows where things stand; leave_waitlist stops waiting (and releases a held slot).`;

const JoinWaitlistInput = z.object({
  date: DateSchema,
  party_size: z.number().int().min(1).max(50).default(1).describe('Number of people'),
  time_from: LocalTimeSchema.optional().describe(
    'Earliest acceptable start time HH:MM (venue local)',
  ),
  time_to: LocalTimeSchema.optional().describe('Latest acceptable start time HH:MM (venue local)'),
  venue_id: z.string().optional().describe('Omit when the server serves a single venue'),
  offering_id: z
    .string()
    .optional()
    .describe('Service id from get_business_info. Omit to accept any service'),
  customer: CustomerSchema.refine((c) => !!c.email, {
    message: 'An email address is needed: that is where the offer is sent',
    path: ['email'],
  }).describe('Who to contact. first_name, last_name and an email address.'),
  user_confirmed: z
    .boolean()
    .describe(
      'Set true ONLY after the user explicitly agreed to be emailed if a time opens up and to have a slot held for them for a short while.',
    ),
  idempotency_key: IdempotencyKeySchema,
});

const CheckWaitlistInput = z.object({
  waitlist_id: z.string().min(1).describe('waitlist_id returned by join_waitlist'),
});

const LeaveWaitlistInput = z.object({
  waitlist_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
});

const WaitlistView = z.object({
  waitlist_id: z.string(),
  status: WaitlistStatusSchema,
  venue: z.object({ id: z.string(), name: z.string() }),
  date: z.string(),
  party_size: z.number(),
  offering_id: z.string().nullable(),
  time_from: z.string().nullable(),
  time_to: z.string().nullable(),
  customer: CustomerSchema,
  waiting_until: z.string().describe('The entry lapses at the end of the requested day'),
  offer: z
    .object({
      booking_id: z.string().describe('Pass to confirm_booking (after the user approves)'),
      start: z.string(),
      end: z.string(),
      local_date: z.string(),
      local_time: z.string(),
      party_size: z.number(),
      offering: z.object({ id: z.string(), name: z.string() }),
      resource: z.string().nullable(),
      price: MoneySchema.nullable(),
      deposit: DepositTermsSchema.nullable(),
      cancellation_policy: CancellationPolicySchema,
      expires_at: z.string(),
      expires_in_seconds: z.number(),
    })
    .nullable()
    .describe('Set while a slot is held for this entry'),
  next_step: z.string(),
});

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export interface WaitlistToolsOptions {
  waitlist: Waitlist;
}

/** Same advertising trick as the booking tools: publish the schema, validate inside the handler. */
function advertised<S extends z.ZodType>(schema: S): S {
  const std = schema['~standard'];
  return {
    '~standard': { ...std, jsonSchema: std.jsonSchema, validate: (value: unknown) => ({ value }) },
  } as unknown as S;
}

function tool<S extends z.ZodType>(
  schema: S,
  fn: (args: z.output<S>) => Promise<Record<string, unknown>>,
) {
  return async (args: unknown): Promise<ToolResult> => {
    const parsed = schema.safeParse(args ?? {});
    try {
      if (!parsed.success) throw fromZodError(parsed.error, 'Invalid arguments');
      const data = await fn(parsed.data);
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    } catch (e) {
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
  };
}

/** Register the three waitlist tools on `server`. `createMcpServer` does this when given a waitlist. */
export function registerWaitlistTools(server: McpServer, options: WaitlistToolsOptions): void {
  const { waitlist } = options;
  const service = waitlist.service;

  const view = async (entry: WaitlistEntry): Promise<Record<string, unknown>> => {
    const venue = (await service.listVenues()).find((v) => v.id === entry.venue_id);
    if (!venue) throw new BookingError('not_found', `Unknown venue ${entry.venue_id}`);
    const holdId = entry.status === 'offered' ? entry.offer?.booking_id : null;
    const hold = holdId ? await service.getBooking(holdId).catch(() => null) : null;
    const now = service.clock.now();
    return {
      waitlist_id: entry.waitlist_id,
      status: entry.status,
      venue: { id: venue.id, name: venue.name },
      date: entry.date,
      party_size: entry.party_size,
      offering_id: entry.offering_id,
      time_from: entry.time_from,
      time_to: entry.time_to,
      customer: entry.customer,
      waiting_until: entry.expires_at,
      offer: hold && hold.status === 'held' ? offerView(hold, venue, now) : null,
      next_step: nextStep(entry, hold, waitlist.offerTtlSeconds),
    };
  };

  const join = JoinWaitlistInput;
  server.registerTool(
    'join_waitlist',
    {
      title: 'Join the waitlist',
      description:
        "Ask to be told when a full time opens up. Only when search_availability found nothing for what the user wants (it refuses otherwise). When someone cancels, a matching slot is held for the first person waiting and they are emailed; nothing is booked until the user confirms it. Needs the user's explicit agreement (user_confirmed=true) and an email address.",
      inputSchema: advertised(join),
      outputSchema: WaitlistView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(join, async (a) =>
      view(
        await waitlist.join({
          date: a.date,
          party_size: a.party_size,
          customer: a.customer,
          user_confirmed: a.user_confirmed,
          idempotency_key: a.idempotency_key,
          ...(a.venue_id ? { venue_id: a.venue_id } : {}),
          ...(a.offering_id ? { offering_id: a.offering_id } : {}),
          ...(a.time_from ? { time_from: a.time_from } : {}),
          ...(a.time_to ? { time_to: a.time_to } : {}),
        }),
      ),
    ),
  );

  const check = CheckWaitlistInput;
  server.registerTool(
    'check_waitlist',
    {
      title: 'Check the waitlist',
      description:
        'Where a waitlist entry stands: still waiting, or offered (a slot is held, with its booking_id and deadline), accepted, or ended. Call it when the user asks, or after they say they got an email.',
      inputSchema: advertised(check),
      outputSchema: WaitlistView,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(check, async (a) => view(await waitlist.get(a.waitlist_id))),
  );

  const leave = LeaveWaitlistInput;
  server.registerTool(
    'leave_waitlist',
    {
      title: 'Leave the waitlist',
      description:
        'Stop waiting. If a slot is currently held for this entry it is released and offered to the next person.',
      inputSchema: advertised(leave),
      outputSchema: WaitlistView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    tool(leave, async (a) => view(await waitlist.leave(a))),
  );
}

function offerView(b: Booking, venue: Venue, now: Date) {
  const start = new Date(b.slot.start);
  return {
    booking_id: b.booking_id,
    start: b.slot.start,
    end: b.slot.end,
    local_date: time.localDate(start, venue.timezone),
    local_time: time.localTime(start, venue.timezone),
    party_size: b.slot.party_size.total,
    offering: b.slot.offering,
    resource: b.slot.resource?.label ?? null,
    price: b.slot.price,
    deposit: b.slot.deposit,
    cancellation_policy: b.slot.cancellation_policy,
    expires_at: b.expires_at ?? '',
    expires_in_seconds: Math.max(
      0,
      Math.floor((new Date(b.expires_at ?? now).getTime() - now.getTime()) / 1000),
    ),
  };
}

function nextStep(entry: WaitlistEntry, hold: Booking | null, offerTtlSeconds: number): string {
  switch (entry.status) {
    case 'waiting':
      return `On the waitlist for ${entry.date}. If a matching time frees up, a slot is held for the user for ${Math.round(offerTtlSeconds / 60)} minutes and they are emailed; nothing is booked automatically. Tell the user that, and call check_waitlist later if they ask. To stop waiting, call leave_waitlist.`;
    case 'offered': {
      if (!hold || hold.status !== 'held') {
        return 'The offer has ended. Call check_waitlist again to see where the entry stands.';
      }
      const price = hold.slot.price ? `, price ${formatMoney(hold.slot.price)}` : '';
      const deposit = hold.slot.deposit
        ? `, deposit ${formatMoney(hold.slot.deposit.amount)} (${hold.slot.deposit.due})`
        : '';
      return `A slot is held for the user until ${hold.expires_at}: ${hold.slot.offering.name} at ${hold.slot.start}${price}${deposit}, cancellation: "${hold.slot.cancellation_policy.description}". It is NOT booked yet. Show the user these details; only after they explicitly approve, call confirm_booking with booking_id=${hold.booking_id} and user_confirmed=true. If they do not want it, call leave_waitlist.`;
    }
    case 'accepted':
      return 'The user confirmed the offered slot. Nothing more to do; call get_booking for the confirmation code.';
    case 'declined':
      return 'The offered slot was released. Tell the user; they can search_availability again or join the waitlist for another time.';
    case 'expired':
      return 'The entry ended without a booking (the day passed, or the offer was not taken in time). Offer to search_availability for another day.';
    case 'cancelled':
      return 'The user left the waitlist. Nothing more to do.';
  }
}
