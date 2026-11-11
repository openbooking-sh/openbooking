/**
 * Where a booking came from: the channel it entered through, and (for assistants) the name the
 * caller reported for itself. Shown to the business in Studio and exports; never used for pricing.
 */
import * as z from 'zod';
import type { Actor } from './actor';

export const BOOKING_CHANNELS = [
  'mcp',
  'ucp',
  'a2a',
  'usp',
  'website',
  'embed',
  'phone',
  'walk_in',
  'other',
] as const;
export const BookingChannelSchema = z.enum(BOOKING_CHANNELS);
export type BookingChannel = z.infer<typeof BookingChannelSchema>;

export const BookingSourceSchema = z.object({
  channel: BookingChannelSchema.describe(
    'The door the booking came through: an agent protocol (mcp, ucp, a2a, usp), the booking page (website), the business’s own site (embed), or staff (phone, walk_in).',
  ),
  agent: z
    .string()
    .max(80)
    .optional()
    .describe(
      'The calling assistant’s own name for itself (MCP clientInfo name, UCP/USP platform host, browser family). Self-reported and NOT verified: fine for statistics, never for trust.',
    ),
});
export type BookingSource = z.infer<typeof BookingSourceSchema>;

/**
 * Display group for a self-reported client name. One small table, first match wins; no network
 * calls. Anything unrecognised is "Other".
 */
const AGENT_GROUPS: Array<[RegExp, string]> = [
  [/chatgpt|openai/i, 'ChatGPT'],
  [/gemini|bard/i, 'Gemini'],
  [/google/i, 'Google'],
  [/claude|anthropic/i, 'Claude'],
  [/perplexity/i, 'Perplexity'],
  [/copilot|bing|microsoft/i, 'Copilot'],
  [/mistral|le ?chat/i, 'Mistral'],
  [/\bsiri\b/i, 'Siri'],
  [/\balexa\b/i, 'Alexa'],
];

export function agentGroup(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  for (const [re, group] of AGENT_GROUPS) if (re.test(agent)) return group;
  return 'Other';
}

/** Channel and coarse agent group only: what analytics may carry. */
export function coarseSource(source: BookingSource | undefined): {
  channel: BookingChannel | 'unknown';
  agent_group: string | null;
} {
  return { channel: source?.channel ?? 'unknown', agent_group: agentGroup(source?.agent) ?? null };
}

const BY_PROTOCOL: Record<Actor['protocol'], BookingChannel> = {
  mcp: 'mcp',
  ucp: 'ucp',
  a2a: 'a2a',
  usp: 'usp',
  web: 'website',
  // Studio is staff; the staff member picks phone or walk-in (Actor.channel). Never guessed.
  studio: 'other',
  api: 'other',
};

/** The source for a booking created by `actor`, or undefined when nobody is identifiable. */
export function sourceFromActor(actor: Actor | undefined): BookingSource | undefined {
  if (!actor) return undefined;
  const channel = actor.channel ?? BY_PROTOCOL[actor.protocol];
  // Staff and the platform itself are not assistants: no agent name to report.
  const reports = actor.protocol !== 'studio' && actor.protocol !== 'api';
  const agent = reports ? clientName(actor.client) : undefined;
  return { channel, ...(agent ? { agent } : {}) };
}

/** A client name without version or platform noise: "Claude-User/1.0 (x)" becomes "Claude-User". */
function clientName(raw: string | undefined): string | undefined {
  const token = raw?.split(/[\s/;(]/)[0];
  if (!token) return undefined;
  return (token === 'Mozilla' ? userAgentFamily(raw) : token)?.slice(0, 80);
}

/** Browser family from a User-Agent, or the assistant's own name when it announces one. */
export function userAgentFamily(ua: string | null | undefined): string | undefined {
  if (!ua) return undefined;
  const assistant = agentGroup(ua);
  if (assistant && assistant !== 'Other') return assistant;
  // Order matters: Edge and Chrome also say "Safari"; Chrome-based browsers also say "Chrome".
  if (/edg(?:e|a|ios)?\//i.test(ua)) return 'Edge';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/chrome|crios/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return ua.split(/[\s/;(]/)[0]?.slice(0, 40) || undefined;
}
