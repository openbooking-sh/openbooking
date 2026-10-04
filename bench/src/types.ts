import * as z from 'zod';

const Time = z.string().regex(/^\d{2}:\d{2}$/);

/** Structured intent behind a task. LLM drivers only see `user_prompt`; scripted drivers use this. */
export const TaskIntentSchema = z.object({
  date: z.iso.date(),
  party_size: z.number().int().positive(),
  time_window: z.tuple([Time, Time]),
  offering_id: z.string().optional(),
  preferences: z.array(z.string()).optional(),
  customer: z.object({
    first_name: z.string(),
    last_name: z.string(),
    email: z.string().optional(),
    phone_number: z.string().optional(),
  }),
  payment_token: z.string().optional(),
  /** After confirming, the user asks to cancel. */
  then_cancel: z.boolean().default(false),
});

export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** What the simulated user says to the agent. */
  user_prompt: z.string(),
  intent: TaskIntentSchema,
  /** Virtual "now" for the run (the clock then advances in real time). */
  now: z.iso.datetime({ offset: true }),
  hold_ttl_seconds: z.number().int().positive().default(600),
  /** Pre-existing holds/bookings to create contention, made before the agent starts. */
  setup: z
    .array(
      z.object({
        date: z.iso.date(),
        time: Time,
        party_size: z.number().int().positive(),
        offering_id: z.string().default('dinner'),
        confirm: z.boolean().default(true),
      }),
    )
    .default([]),
  /** Fault injection. */
  inject: z
    .object({
      /** Advance the clock by this many seconds right before the agent's first confirm_booking. */
      advance_clock_before_first_confirm_seconds: z.number().int().positive().optional(),
    })
    .default({}),
  expect: z.object({
    outcome: z.enum(['confirmed', 'cancelled', 'no_booking']),
    /** Max bookings the agent may leave confirmed (anything above is a double booking). */
    max_confirmed_bookings: z.number().int().min(0).default(1),
  }),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskIntent = z.infer<typeof TaskIntentSchema>;

export interface DriverContext {
  task: Task;
  /** MCP Streamable HTTP endpoint of a fresh, isolated server for this task. */
  mcpUrl: string;
  /** Suggested system prompt for LLM drivers. */
  systemPrompt: string;
  signal: AbortSignal;
}

export interface DriverResult {
  /** The agent's final message to the user, if any. */
  final_message?: string;
  /** Free-form transcript for debugging (tool calls, model turns). */
  transcript?: unknown[];
}

/**
 * Something that tries to accomplish a task by talking to the MCP endpoint: an LLM agent loop, or
 * the deterministic scripted baseline.
 */
export interface AgentDriver {
  readonly name: string;
  run(ctx: DriverContext): Promise<DriverResult>;
}

export interface TaskRunResult {
  task_id: string;
  driver: string;
  success: boolean;
  /** Why the run failed expectations, if it did. */
  failure_reason?: string;
  outcome: 'confirmed' | 'cancelled' | 'no_booking';
  confirmed_bookings: number;
  /** Confirmed bookings beyond `max_confirmed_bookings`, plus any resource overlaps. */
  double_bookings: number;
  expired_hold_errors: number;
  tool_calls: number;
  errors_by_code: Record<string, number>;
  duration_ms: number;
  driver_error?: string;
}

export interface DriverSummary {
  driver: string;
  tasks: number;
  completion_rate: number;
  double_bookings: number;
  expired_hold_errors: number;
  avg_tool_calls: number;
}
