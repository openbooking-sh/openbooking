/**
 * Who is making the current call: which AI agent (Claude, ChatGPT, …) over which protocol.
 *
 * Adapters/servers wrap request handling in `runAsActor(...)`; the BookingService reads the
 * current actor and stamps it on every BookingEvent. Uses AsyncLocalStorage, so nothing has to be
 * threaded through tool handlers by hand.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Actor {
  /** Channel the call came through. `studio` = a human using the dashboard. */
  protocol: 'mcp' | 'ucp' | 'a2a' | 'studio' | 'api';
  /** Display name, e.g. "Claude", "ChatGPT", "MCP Inspector", "Unknown agent". */
  agent: string;
  /** Raw client identifier as reported (MCP clientInfo name, User-Agent, UCP-Agent profile). */
  client?: string;
}

const storage = new AsyncLocalStorage<Actor>();

/** Run `fn` with `actor` as the current actor for every BookingService call inside it. */
export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

/** The actor of the current call, if any. */
export function currentActor(): Actor | undefined {
  return storage.getStore();
}
