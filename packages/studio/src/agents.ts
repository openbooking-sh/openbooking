/**
 * Best-effort identification of which AI assistant is calling, from what clients report about
 * themselves: MCP `clientInfo.name` (every request in the 2026-07-28 era via `_meta`, only on
 * `initialize` in the 2025 era), the HTTP `User-Agent`, or a UCP `UCP-Agent` profile URL.
 *
 * This is self-reported and spoofable: fine for analytics, never for authorization.
 */
import { clientIpFromHeaders, type Actor } from '@openbooking-sh/core';

const KNOWN: Array<[RegExp, string]> = [
  [/claude|anthropic/i, 'Claude'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/gemini|google/i, 'Gemini'],
  [/perplexity/i, 'Perplexity'],
  [/mistral|le ?chat/i, 'Mistral'],
  [/copilot/i, 'Copilot'],
  [/cursor/i, 'Cursor'],
  [/inspector/i, 'MCP Inspector'],
  [/openbooking-bench/i, 'Benchmark'],
];

export const MCP_CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/** Map a raw client identifier to a display name ("Claude", "ChatGPT", …). */
export function agentName(raw: string | undefined): string {
  if (!raw) return 'Unknown agent';
  for (const [re, name] of KNOWN) if (re.test(raw)) return name;
  // First product token of a User-Agent ("node", "curl/8.4" → "curl"), or the client name.
  return raw.split(/[\s/;(]/)[0] || 'Unknown agent';
}

function mcpClientName(body: unknown): string | undefined {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const params = (m as { params?: Record<string, unknown> }).params;
    const meta = params?._meta as Record<string, { name?: unknown }> | undefined;
    const fromMeta = meta?.[MCP_CLIENT_INFO_META_KEY]?.name;
    if (typeof fromMeta === 'string') return fromMeta;
    const fromInit = (params?.clientInfo as { name?: unknown } | undefined)?.name;
    if (typeof fromInit === 'string') return fromInit;
  }
  return undefined;
}

function ucpAgentHost(header: string | null): string | undefined {
  const m = header?.match(/profile="([^"]+)"/);
  if (!m?.[1]) return undefined;
  try {
    return new URL(m[1]).hostname;
  } catch {
    return undefined;
  }
}

/** Build an Actor for an incoming request without consuming its body. */
export async function actorFromRequest(req: Request, protocol: Actor['protocol']): Promise<Actor> {
  const ua = req.headers.get('user-agent') ?? undefined;
  let client: string | undefined;
  if (protocol === 'mcp' && req.method === 'POST') {
    try {
      client = mcpClientName(JSON.parse(await req.clone().text()));
    } catch {
      // not JSON; fall back to headers
    }
  }
  if (protocol === 'ucp') client = ucpAgentHost(req.headers.get('ucp-agent'));
  const raw = client ?? ua;
  const ip = clientIpFromHeaders(req.headers);
  return {
    protocol,
    agent: agentName(raw),
    ...(raw ? { client: raw } : {}),
    ...(ip ? { ip } : {}),
  };
}
