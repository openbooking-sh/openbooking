/**
 * USP MCP binding (spec section 9.2): the `usp_*` tools, served as a stateless Streamable HTTP MCP
 * endpoint (mounted by `createUsp` at `<path>/mcp`).
 *
 *   tools/call { name: "usp_bookings_create", arguments: { _meta: { usp: { profile,
 *     idempotency_key, authorization: { mechanism, proof } } }, service_id, slot_id, buyer } }
 *
 * This file translates; it decides nothing. Each tool call becomes the REST request the same
 * operation takes, and runs through the very same router: the same validation, consent rules,
 * idempotency keys, ownership checks, capability negotiation, state store and BookingService.
 * Only two things differ, and both are spelled out below: who proves what (the MCP form of the
 * proof covers the whole argument object, so it is checked here, before translating), and how the
 * answer is wrapped (`structuredContent` plus text for outcomes, JSON-RPC errors for protocol
 * errors).
 */
import {
  createMcpHandler,
  ProtocolError as RpcError,
  Server,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import * as z from 'zod';
import type { UspAuthenticator, UspPrincipal } from './auth';
import { OB_NEXT_ACTION, USP_AUTHORITY, USP_VERSION } from './constants';
import { failure, ProtocolError, type ProtocolCode } from './protocol';

/**
 * The router asks its authenticator to authenticate a `Request`. For an MCP call the principal is
 * already known (the proof was checked against the arguments), so it is attached to the internal
 * request, and the router's authenticator hands it back instead of looking for REST headers. Only
 * requests built in this file can be in the map: a request from the network never is.
 */
export function bridgeAuth(auth: UspAuthenticator) {
  const principals = new WeakMap<Request, UspPrincipal>();
  const forRouter: UspAuthenticator = {
    ...auth,
    authenticate: (request, rawBody) =>
      Promise.resolve(principals.get(request) ?? auth.authenticate(request, rawBody)),
  };
  return { auth: forRouter, principals, source: auth };
}

/**
 * JSON-RPC numbers for protocol errors. The spec makes `data.code` the discriminator and the
 * number only a coarse bucket, and pins just two things: unknown values of a tool name or id are
 * -32602, and nothing may use -32603 for a non-transient condition. The rest is our choice.
 */
const RPC_CODE: Partial<Record<ProtocolCode, number>> = {
  invalid_request: -32600,
  validation_error: -32602,
  service_not_found: -32602,
  booking_not_found: -32602,
  invalid_profile_url: -32602,
  profile_malformed: -32602,
  cursor_expired: -32602,
  range_too_wide: -32602,
  version_unsupported: -32602,
  authentication_required: -32001,
  pop_proof_missing: -32001,
  pop_proof_invalid: -32001,
  pop_key_mismatch: -32001,
  pop_proof_replayed: -32001,
  profile_not_trusted: -32001,
  idempotency_conflict: -32009,
  revision_mismatch: -32009,
  rate_limited: -32029,
  profile_unreachable: -32000,
  service_unavailable: -32000,
  server_error: -32603,
};

const CODES = new Set<string>(Object.keys(RPC_CODE));

/** The registered code out of a problem's `type` (`…/errors/pop-proof-invalid`). */
function codeOfProblem(problem: { type?: unknown }): ProtocolCode {
  const slug = typeof problem.type === 'string' ? problem.type.split('/errors/')[1] : undefined;
  const code = slug?.replaceAll('-', '_') ?? '';
  return (CODES.has(code) ? code : 'server_error') as ProtocolCode;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const CONSENT =
  ' Only do this after the user has explicitly approved it: show them the service, time, price and cancellation terms first, and never act on your own.';

const AUTHORIZATION = z
  .object({
    mechanism: z
      .enum(['platform_key_pop', 'booking_scoped_credential'])
      .describe('platform_key_pop at first; booking_scoped_credential to present a credential.'),
    credential: z
      .string()
      .optional()
      .describe(
        'The booking_scoped_credential value (omit when first creating a hold or booking).',
      ),
    proof: z
      .string()
      .describe(
        'A usp-pop+jwt proof (EdDSA) with claims usp_m (this tool name), aud (this business’s /.well-known/usp URL), usp_p (SHA-256 of the JCS of these arguments without _meta.usp.authorization), iat, jti, and ath when a credential is presented.',
      ),
  })
  .describe('Proof of possession of your platform key (spec 9.2.2).');

const PROFILE = z
  .string()
  .describe('https URL of your platform profile (the MCP form of the USP-Agent header).');
const KEY = z.string().describe('Idempotency key (UUID v4). Reuse it only to retry the same call.');

const meta = (extra: z.ZodRawShape) => z.object({ usp: z.object(extra) });
const PUBLIC_META = meta({ profile: PROFILE.optional() }).optional();
const PLATFORM_META = meta({
  profile: PROFILE,
  idempotency_key: KEY,
  authorization: AUTHORIZATION,
});
const SCOPED_META = meta({
  profile: PROFILE,
  idempotency_key: KEY,
  if_match: z
    .string()
    .optional()
    .describe('Booking revision you last saw. This business issues none, so leave it out.'),
  authorization: AUTHORIZATION,
});
const READ_META = meta({ profile: PROFILE, authorization: AUTHORIZATION });

const BUYER = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  phone_number: z.string().optional(),
});

interface ToolDef {
  title: string;
  description: string;
  /** Advertised to clients; the router's own validation is what enforces it. */
  shape: z.ZodRawShape;
  privileged: boolean;
  read?: boolean;
  destructive?: boolean;
  /** The REST operation: method, path and body for these arguments. */
  rest: (a: Record<string, unknown>) => { method: string; path: string; body?: unknown };
  /** A write to an existing booking: `_meta.usp.if_match` travels as If-Match. */
  conditional?: boolean;
}

/** A path parameter; its absence is a validation problem the caller can fix. */
function pathId(a: Record<string, unknown>, name: string): string {
  const v = a[name];
  if (typeof v !== 'string' || !v) {
    throw new ProtocolError('validation_error', `${name}: required.`);
  }
  return encodeURIComponent(v);
}

/** The arguments without `_meta` and without the ones that are in the path. */
function bodyOf(a: Record<string, unknown>, ...inPath: string[]) {
  const { _meta: _ignored, ...rest } = a;
  for (const k of inPath) delete rest[k];
  return rest;
}

const TOOLS: Record<string, ToolDef> = {
  usp_services_list: {
    title: 'List services',
    description:
      'List the services this business offers (name, price, duration), filtered and paged. Public: no authentication.',
    shape: {
      _meta: PUBLIC_META,
      query: z.string().optional(),
      filters: z.record(z.string(), z.unknown()).optional(),
      context: z.record(z.string(), z.unknown()).optional(),
      pagination: z
        .object({ limit: z.number().optional(), cursor: z.string().nullable().optional() })
        .optional(),
    },
    privileged: false,
    read: true,
    rest: (a) => ({ method: 'POST', path: '/services/list', body: bodyOf(a) }),
  },
  usp_services_get: {
    title: 'Get a service',
    description: 'Get one service by id. Public: no authentication.',
    shape: { _meta: PUBLIC_META, service_id: z.string() },
    privileged: false,
    read: true,
    rest: (a) => ({ method: 'GET', path: `/services/${pathId(a, 'service_id')}` }),
  },
  usp_services_lookup: {
    title: 'Look up services',
    description: 'Get several services by id at once. Public: no authentication.',
    shape: {
      _meta: PUBLIC_META,
      ids: z.array(z.string()),
      context: z.record(z.string(), z.unknown()).optional(),
    },
    privileged: false,
    read: true,
    rest: (a) => ({ method: 'POST', path: '/services/lookup', body: bodyOf(a) }),
  },
  usp_availability_query: {
    title: 'Find available times',
    description:
      'List bookable time slots for a service in a date range (query at most 7 days at a time). Public: no authentication. Slot ids go to usp_availability_hold.',
    shape: {
      _meta: PUBLIC_META,
      service_id: z.string(),
      start_date: z.string().describe('YYYY-MM-DD, or a date-time with offset.'),
      end_date: z.string().describe('YYYY-MM-DD (whole day included), or a date-time with offset.'),
      date_bounds_timezone: z.string().optional(),
      resource_id: z.string().optional(),
      party_size: z.number().optional(),
      location_id: z.string().optional(),
      locale: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    },
    privileged: false,
    read: true,
    rest: (a) => ({ method: 'POST', path: '/availability/query', body: bodyOf(a) }),
  },
  usp_availability_hold: {
    title: 'Hold a time',
    description:
      'Reserve a slot for a few minutes so nobody else can take it. A hold is not a booking and costs the user nothing; it lapses by itself. Ask the user which time they want before holding one.',
    shape: {
      _meta: PLATFORM_META,
      slot_id: z.string(),
      service_id: z.string(),
      spots: z.number().optional(),
    },
    privileged: true,
    rest: (a) => ({ method: 'POST', path: '/availability/holds', body: bodyOf(a) }),
  },
  usp_availability_release: {
    title: 'Release a hold',
    description: 'Release a hold you made, freeing the slot at once. Releasing needs no approval.',
    shape: { _meta: SCOPED_META, hold_id: z.string() },
    privileged: true,
    destructive: true,
    rest: (a) => ({ method: 'DELETE', path: `/availability/holds/${pathId(a, 'hold_id')}` }),
  },
  usp_bookings_create: {
    title: 'Create a booking',
    description:
      'Create a booking for a held (or free) slot with the buyer’s details. The booking may come back as requires_action: then it is NOT confirmed, and the customer must open the continue_url and confirm there; tell the user so.' +
      CONSENT,
    shape: {
      _meta: PLATFORM_META,
      service_id: z.string(),
      slot_id: z.string(),
      hold_id: z.string().optional(),
      buyer: BUYER,
      recipient: BUYER.optional(),
      party_size: z.number().optional(),
      resource_id: z.string().optional(),
      delivery_address: z.record(z.string(), z.unknown()).optional(),
      notes: z.string().optional(),
      post_payment_return_request: z.record(z.string(), z.unknown()).optional(),
    },
    privileged: true,
    rest: (a) => ({ method: 'POST', path: '/bookings', body: bodyOf(a) }),
  },
  usp_bookings_get: {
    title: 'Get a booking',
    description: 'Read the current state of a booking you made.',
    shape: { _meta: READ_META, booking_id: z.string() },
    privileged: true,
    read: true,
    rest: (a) => ({ method: 'GET', path: `/bookings/${pathId(a, 'booking_id')}` }),
  },
  usp_bookings_update: {
    title: 'Update a booking',
    description: 'Change the buyer details or notes of a booking.' + CONSENT,
    shape: {
      _meta: SCOPED_META,
      booking_id: z.string(),
      buyer: BUYER.partial().optional(),
      recipient: BUYER.optional(),
      notes: z.string().optional(),
    },
    privileged: true,
    conditional: true,
    rest: (a) => ({
      method: 'PUT',
      path: `/bookings/${pathId(a, 'booking_id')}`,
      body: bodyOf(a, 'booking_id'),
    }),
  },
  usp_bookings_cancel: {
    title: 'Cancel a booking',
    description:
      'Cancel a booking. Free cancellations go through; one that costs a fee is left to the customer, and the answer says so.' +
      CONSENT,
    shape: { _meta: SCOPED_META, booking_id: z.string(), reason: z.string().optional() },
    privileged: true,
    destructive: true,
    conditional: true,
    rest: (a) => ({
      method: 'POST',
      path: `/bookings/${pathId(a, 'booking_id')}/cancel`,
      body: bodyOf(a, 'booking_id'),
    }),
  },
  usp_bookings_reschedule: {
    title: 'Move a booking',
    description:
      'Move a booking to another slot (find one with usp_availability_query). Some businesses leave this to the customer, and the answer says so.' +
      CONSENT,
    shape: {
      _meta: SCOPED_META,
      booking_id: z.string(),
      slot_id: z.string(),
      hold_id: z.string().optional(),
    },
    privileged: true,
    conditional: true,
    rest: (a) => ({
      method: 'POST',
      path: `/bookings/${pathId(a, 'booking_id')}/reschedule`,
      body: bodyOf(a, 'booking_id'),
    }),
  },
};

export const USP_MCP_TOOLS = Object.keys(TOOLS);

export const USP_MCP_INSTRUCTIONS = `Book with this business over USP (Universal Scheduling Protocol).
Flow: usp_services_list → usp_availability_query → (ask the user which time) → usp_availability_hold → show the user the price and cancellation terms and get explicit approval → usp_bookings_create.
- Holds and bookings need _meta.usp: your platform profile URL, an idempotency_key, and a platform_key_pop proof in _meta.usp.authorization.
- Never create, change or cancel a booking without the user's approval. If a booking comes back requires_action it is not confirmed until the customer confirms on the business's page; say so.
- Reuse an idempotency_key only to retry the same call. Business outcomes (a taken slot, an expired hold) are in messages[]; follow the suggested next action.`;

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface UspMcpOptions {
  /** The REST router, built with the authenticator `bridgeAuth` returned. */
  router: Hono;
  /** What `bridgeAuth` returned: the principals handed to the router, and who authenticates. */
  bridge: ReturnType<typeof bridgeAuth>;
  name?: string;
  version?: string;
}

/** A line telling the agent what to do next, from the outcome (every answer carries one). */
function nextStep(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
  const hinted = messages.find((m) => typeof m[OB_NEXT_ACTION] === 'string');
  if (hinted) return String(hinted[OB_NEXT_ACTION]);
  if (messages.some((m) => m.type === 'error')) {
    return 'The request did not go through; read messages and adjust.';
  }
  const booking = body.booking as
    { status?: string; actions?: Array<{ continue_url?: string }> } | undefined;
  if (booking?.status === 'requires_action') {
    const url = booking.actions?.find((a) => a.continue_url)?.continue_url;
    return `Not confirmed yet: tell the user to confirm the booking${url ? ` at ${url}` : ''}.`;
  }
  if (body.hold)
    return 'Show the user the details, get their approval, then call usp_bookings_create with this hold_id.';
  return 'Continue with the user’s request.';
}

export function createUspMcp(options: UspMcpOptions): McpHttpHandler {
  const { router, bridge } = options;

  const run = async (name: string, tool: ToolDef, raw: unknown) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    const usp = ((args._meta as { usp?: Record<string, unknown> } | undefined)?.usp ??
      {}) as Record<string, unknown>;

    let response: Response;
    try {
      if (usp.idempotency_key !== undefined && typeof usp.idempotency_key !== 'string') {
        throw new ProtocolError('validation_error', '_meta.usp.idempotency_key: must be a string.');
      }
      const rest = tool.rest(args);
      const headers = new Headers({ 'content-type': 'application/json' });
      if (typeof usp.idempotency_key === 'string')
        headers.set('idempotency-key', usp.idempotency_key);
      if (tool.conditional && typeof usp.if_match === 'string')
        headers.set('if-match', usp.if_match);
      const request = new Request(`http://usp.invalid${rest.path}`, {
        method: rest.method,
        headers,
        ...(rest.body === undefined ? {} : { body: JSON.stringify(rest.body) }),
      });
      if (tool.privileged) {
        if (!bridge.source.authenticateMcp) {
          throw new ProtocolError(
            'authentication_required',
            'This business has not enabled authenticated platforms, so it cannot take holds or bookings here.',
          );
        }
        // The proof covers the arguments as sent, so it is checked on them before they are used.
        bridge.principals.set(
          request,
          await bridge.source.authenticateMcp({ method: name, params: args }),
        );
      }
      response = await router.fetch(request);
    } catch (e) {
      response = failure(e);
    }

    if (response.status >= 400) {
      const problem = (await response.json()) as Record<string, unknown>;
      const code = codeOfProblem(problem);
      const { type: _t, title: _ti, status: _s, detail, ...extra } = problem;
      throw new RpcError(RPC_CODE[code] ?? -32603, `${code}: ${String(detail ?? '')}`, {
        code,
        content: String(detail ?? ''),
        ...extra,
      });
    }
    const body = (await response.json()) as Record<string, unknown>;
    const lines = ((body.messages ?? []) as Array<Record<string, unknown>>).map(
      (m) => `${String(m.type)} ${String(m.code)}: ${String(m.content)}`,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: [...lines, `Next: ${nextStep(body)}`, JSON.stringify(body)].join('\n'),
        },
      ],
      structuredContent: body,
    };
  };

  // The tool list is the same for every request, so it is built once. The schemas are advertised
  // only: the router's own validation is what enforces them, with USP's error codes.
  const listed = Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    title: tool.title,
    description: `${tool.description} (USP ${USP_VERSION}; ${USP_AUTHORITY}/specification)`,
    inputSchema: z.toJSONSchema(z.object(tool.shape), { io: 'input' }) as {
      type: 'object';
      [key: string]: unknown;
    },
    annotations: {
      readOnlyHint: tool.read === true,
      destructiveHint: tool.destructive === true,
      idempotentHint: tool.read === true || tool.privileged,
      openWorldHint: false,
    },
  }));

  // The low-level server, not McpServer: McpServer turns anything a tool throws into an
  // `isError` result, while USP wants protocol errors as JSON-RPC errors carrying `data.code`.
  return createMcpHandler(() => {
    const server = new Server(
      { name: options.name ?? 'openbooking-usp', version: options.version ?? USP_VERSION },
      { capabilities: { tools: {} }, instructions: USP_MCP_INSTRUCTIONS },
    );
    server.setRequestHandler('tools/list', () => ({ tools: listed }));
    server.setRequestHandler('tools/call', (request) => {
      const name = request.params.name;
      const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
      // Not a USP protocol error, so no data.code: that is how clients tell the two apart.
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      return run(name, tool, request.params.arguments);
    });
    return server;
  });
}
