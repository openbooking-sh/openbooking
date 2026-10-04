import type { BookingService } from '@openbooking/core';
import { A2A_PROTOCOL_VERSION } from './agent-card';

/**
 * Planned A2A adapter surface. STUB: task handling is not implemented yet.
 *
 * When implemented, `SendMessage` (A2A v1.0 PascalCase JSON-RPC method) will route a structured
 * `DataPart` like `{ skill: "book", ... }` to the same BookingService the MCP and UCP adapters use,
 * so A2A clients get identical idempotency, hold-expiry and confirmation guarantees.
 */
export interface A2AAdapter {
  /** Web-standard handler for the A2A JSON-RPC endpoint. */
  fetch(request: Request): Promise<Response>;
}

export interface A2AAdapterOptions {
  service: BookingService;
}

/**
 * Returns a handler that answers every A2A call with a JSON-RPC error explaining that the
 * transport is not implemented yet, pointing callers at the MCP and UCP endpoints instead.
 */
export function createA2AStub(_options: A2AAdapterOptions): A2AAdapter {
  return {
    async fetch(request: Request): Promise<Response> {
      let id: unknown = null;
      try {
        const body = (await request.json()) as { id?: unknown };
        id = body?.id ?? null;
      } catch {
        // not JSON; keep id null
      }
      return Response.json(
        {
          jsonrpc: '2.0',
          id,
          error: {
            // JSON-RPC "Method not found".
            code: -32601,
            message:
              'A2A task handling is not implemented yet in OpenBooking. Use the MCP endpoint (/mcp) or UCP REST (/ucp).',
          },
        },
        { status: 501, headers: { 'A2A-Version': A2A_PROTOCOL_VERSION } },
      );
    },
  };
}
