import type { AgentDriver, DriverContext, DriverResult } from '../types';

/**
 * One model turn: given the conversation and MCP tool definitions, return either tool calls or a
 * final message. Implement this per provider (Anthropic, OpenAI, local models, ...).
 */
export interface ModelAdapter {
  readonly id: string;
  turn(input: {
    system: string;
    messages: unknown[];
    tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
    signal: AbortSignal;
  }): Promise<
    | {
        type: 'tool_calls';
        calls: Array<{ id: string; name: string; arguments: unknown }>;
        message: unknown;
      }
    | { type: 'final'; text: string; message: unknown }
  >;
}

/**
 * Plays the human. The default policy approves the first fully specified proposal, which is
 * what the task prompts state ("go ahead and confirm").
 */
export interface SimulatedUser {
  reply(agentMessage: string, ctx: DriverContext): Promise<string | null>;
}

/**
 * STUB: LLM-backed driver. Planned loop:
 *  1. connect an MCP client to ctx.mcpUrl and list tools
 *  2. send ctx.systemPrompt + task.user_prompt to the model with those tools
 *  3. execute tool calls via MCP, feed results back, repeat
 *  4. when the model asks the user something, answer with SimulatedUser
 *  5. stop on a final answer, max turns, or ctx.signal
 *
 * The runner then scores the resulting booking state (completion, double bookings, expired holds).
 */
export class LlmDriver implements AgentDriver {
  readonly name: string;

  constructor(
    readonly model: ModelAdapter,
    readonly user?: SimulatedUser,
  ) {
    this.name = `llm:${model.id}`;
  }

  async run(_ctx: DriverContext): Promise<DriverResult> {
    throw new Error(
      'LlmDriver is not implemented yet: provide a ModelAdapter and implement the tool loop (see bench/README.md).',
    );
  }
}
