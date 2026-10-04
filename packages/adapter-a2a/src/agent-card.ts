/**
 * A2A Agent Card types and builder, per A2A spec v1.0 (protocol version "1.0"; normative source
 * `specification/a2a.proto` in github.com/a2aproject/A2A). JSON field names are the camelCase of
 * the proto names. Served at `/.well-known/agent-card.json` (spec §8.2).
 *
 * v1.0 removed the top-level `url`, `protocolVersion`, `preferredTransport` and
 * `additionalInterfaces` in favour of the ordered `supportedInterfaces[]`.
 */

export const A2A_PROTOCOL_VERSION = '1.0';
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Open string; the spec defines these three. */
export type ProtocolBinding = 'JSONRPC' | 'GRPC' | 'HTTP+JSON' | (string & {});

export interface AgentInterface {
  url: string;
  protocolBinding: ProtocolBinding;
  protocolVersion: string;
  tenant?: string;
}

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentProvider {
  organization: string;
  url: string;
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: Array<{ schemes: Record<string, { list: string[] }> }>;
}

export interface AgentCardOptions {
  name: string;
  description: string;
  /** Public origin, e.g. `https://bistro.example.com`. */
  baseUrl: string;
  /** Path of the A2A JSON-RPC endpoint. Default `/a2a`. */
  a2aPath?: string;
  /** The agent's own version (not the protocol version). */
  version?: string;
  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  /** Extra skills beyond the default booking skills. */
  skills?: AgentSkill[];
  /** Advertise the MCP endpoint as an A2A extension pointer (informational). */
  mcpUrl?: string;
}

/** The booking capabilities expressed as A2A skills (one per agent-facing operation group). */
export const DEFAULT_BOOKING_SKILLS: AgentSkill[] = [
  {
    id: 'search_availability',
    name: 'Search availability',
    description:
      'Find bookable time slots for a date and party size, with price, deposit and cancellation policy.',
    tags: ['booking', 'availability', 'reservation'],
    examples: ['Is there a table for 4 on Friday around 19:00?'],
  },
  {
    id: 'book',
    name: 'Hold and confirm a booking',
    description:
      'Hold a slot (expires after a few minutes) and confirm it after explicit user approval. Idempotent with an idempotency key.',
    tags: ['booking', 'reservation', 'hold', 'confirm'],
    examples: ['Book the 19:30 table for 2 under Ada Lovelace, ada@example.com.'],
  },
  {
    id: 'manage_booking',
    name: 'Look up or cancel a booking',
    description: 'Check booking status or cancel it, applying the cancellation policy.',
    tags: ['booking', 'cancellation'],
    examples: ['Cancel booking bk_123.'],
  },
];

export function buildAgentCard(options: AgentCardOptions): AgentCard {
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    name: options.name,
    description: options.description,
    supportedInterfaces: [
      {
        url: `${base}${options.a2aPath ?? '/a2a'}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    version: options.version ?? '0.1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      ...(options.mcpUrl
        ? {
            extensions: [
              {
                // EXTENSION: OpenBooking-defined, informational pointer to the MCP endpoint.
                uri: 'https://openbooking.sh/a2a/extensions/mcp-endpoint/v1',
                description: 'The same booking tools are available over MCP (Streamable HTTP).',
                required: false,
                params: { url: options.mcpUrl },
              },
            ],
          }
        : {}),
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [...DEFAULT_BOOKING_SKILLS, ...(options.skills ?? [])],
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.documentationUrl ? { documentationUrl: options.documentationUrl } : {}),
    ...(options.iconUrl ? { iconUrl: options.iconUrl } : {}),
  };
}
