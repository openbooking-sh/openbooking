import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpAdapterOptions } from './server';

/**
 * Serve the OpenBooking tools over stdio (for local testing with Claude Desktop, MCP Inspector,
 * etc.). Never write to stdout yourself while this runs; stdout is the protocol channel.
 */
export function serveMcpStdio(options: McpAdapterOptions): { close(): Promise<void> } {
  const handle = serveStdio(() => createMcpServer(options));
  return { close: async () => void (await handle.close()) };
}
