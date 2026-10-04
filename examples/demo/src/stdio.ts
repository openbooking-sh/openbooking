/**
 * The demo restaurant over MCP stdio, for local MCP clients:
 *
 *   {
 *     "mcpServers": {
 *       "demo-bistro": {
 *         "command": "pnpm",
 *         "args": ["--silent", "--dir", "/path/to/openbooking/examples/demo", "stdio"]
 *       }
 *     }
 *   }
 *
 * stdout carries the protocol; log to stderr only.
 */
import { serveMcpStdio } from '@openbooking/adapter-mcp';
import { BookingService } from '@openbooking/core';
import {
  createDemoRestaurantProvider,
  createDemoSalonProvider,
} from '@openbooking/provider-memory';

const service = new BookingService({
  provider:
    process.env.DEMO === 'restaurant' ? createDemoRestaurantProvider() : createDemoSalonProvider(),
});
const handle = serveMcpStdio({ service });
console.error('OpenBooking demo MCP server listening on stdio');

process.on('SIGINT', () => void handle.close().then(() => process.exit(0)));
