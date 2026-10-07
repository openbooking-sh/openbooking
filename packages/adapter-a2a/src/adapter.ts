import { toErrorPayload, type BookingService } from '@openbooking-sh/core';
import { A2A_PROTOCOL_VERSION } from './agent-card';
import { SKILL_HANDLERS, SKILL_IDS, type SkillId } from './skills';

/**
 * A2A v1.0 JSON-RPC endpoint on top of a BookingService, so A2A clients get the same idempotency,
 * hold-expiry and explicit-confirmation guarantees as MCP and UCP.
 *
 * Stateless by design: every `SendMessage` is answered with a `Message` (never a `Task`), because
 * each booking operation completes within the request. A `DataPart` selects the operation:
 * `{ "skill": "search_availability", "date": "2026-10-09", ... }`. `GetTask` and `CancelTask`
 * therefore always answer TaskNotFound.
 */
export interface A2AAdapter {
  /** Web-standard handler for the A2A JSON-RPC endpoint. */
  fetch(request: Request): Promise<Response>;
}

export interface A2AAdapterOptions {
  service: BookingService;
}

// JSON-RPC and A2A v1.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const TASK_NOT_FOUND = -32001;
const UNSUPPORTED_OPERATION = -32004;

const HEADERS = { 'A2A-Version': A2A_PROTOCOL_VERSION };

type Id = string | number | null;

function rpcError(id: Id, code: number, message: string, status = 200): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status, headers: HEADERS },
  );
}

function rpcResult(id: Id, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: HEADERS });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first DataPart's object, or null. v1.0 parts are `{ data, mediaType }`. */
function findData(parts: unknown[]): Record<string, unknown> | null {
  for (const p of parts) if (isObject(p) && isObject(p.data)) return p.data;
  return null;
}

function summaryText(data: Record<string, unknown>): string {
  if (isObject(data.error)) {
    const e = data.error;
    return `Error ${String(e.code)}: ${String(e.message)} Next: ${String(e.suggested_next_action)}`;
  }
  return typeof data.next_step === 'string' ? data.next_step : 'Done.';
}

function agentMessage(contextId: string | undefined, data: Record<string, unknown>) {
  return {
    messageId: crypto.randomUUID(),
    ...(contextId ? { contextId } : {}),
    role: 'ROLE_AGENT',
    parts: [
      { data, mediaType: 'application/json' },
      { text: summaryText(data), mediaType: 'text/plain' },
    ],
  };
}

export const A2A_USAGE =
  'Send a data part like {"skill": "search_availability", "date": "YYYY-MM-DD", "party_size": 2}. ' +
  `Skills: ${SKILL_IDS.join(', ')}. Start with get_business_info. Mutating skills need an idempotency_key, ` +
  'and confirm_booking needs user_confirmed=true only after the user explicitly approved.';

/** Build the A2A JSON-RPC handler. */
export function createA2AAdapter(options: A2AAdapterOptions): A2AAdapter {
  const { service } = options;

  async function sendMessage(id: Id, params: unknown): Promise<Response> {
    const message = isObject(params) && isObject(params.message) ? params.message : null;
    if (!message || !Array.isArray(message.parts)) {
      return rpcError(id, INVALID_PARAMS, 'params.message with a parts array is required.');
    }
    const contextId = typeof message.contextId === 'string' ? message.contextId : undefined;
    const data = findData(message.parts);
    const skill = data?.skill;
    if (!data || typeof skill !== 'string' || !SKILL_IDS.includes(skill as SkillId)) {
      return rpcResult(id, {
        message: agentMessage(contextId, {
          error: {
            code: 'validation_error',
            message: 'No known skill requested.',
            suggested_next_action: A2A_USAGE,
            retryable: false,
          },
        }),
      });
    }
    const { skill: _skill, ...args } = data;
    let result: Record<string, unknown>;
    try {
      result = await SKILL_HANDLERS[skill as SkillId](service, args);
    } catch (e) {
      // Business failures are an answer, not a protocol error: the agent reads the next action.
      result = { error: toErrorPayload(e) };
    }
    return rpcResult(id, { message: agentMessage(contextId, result) });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return rpcError(null, PARSE_ERROR, 'Request body is not valid JSON.', 400);
      }
      if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
        return rpcError(null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.', 400);
      }
      const id: Id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;

      switch (body.method) {
        case 'SendMessage':
        case 'message/send': // v0.3 spelling, accepted for older clients
          return sendMessage(id, body.params);
        case 'GetTask':
        case 'CancelTask':
        case 'tasks/get':
        case 'tasks/cancel':
          return rpcError(
            id,
            TASK_NOT_FOUND,
            'This agent never creates tasks: every SendMessage is answered directly.',
          );
        case 'SendStreamingMessage':
        case 'SubscribeToTask':
        case 'message/stream':
        case 'CreateTaskPushNotificationConfig':
          return rpcError(id, UNSUPPORTED_OPERATION, 'Streaming and push are not supported.');
        default:
          return rpcError(id, METHOD_NOT_FOUND, `Unknown method "${String(body.method)}".`);
      }
    },
  };
}
