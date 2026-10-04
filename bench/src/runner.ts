import { randomUUID } from 'node:crypto';
import { BookingService, time, type BookingEvent, type Clock } from '@openbooking/core';
import {
  createDemoRestaurantProvider,
  type MemoryBookingProvider,
} from '@openbooking/provider-memory';
import { createOpenBookingApp, listen } from '@openbooking/server';
import type { AgentDriver, DriverSummary, Task, TaskRunResult } from './types';

export const AGENT_SYSTEM_PROMPT = `You are a booking assistant with access to a restaurant booking system via tools.
Help the user book exactly what they ask for. Show them the price, deposit and cancellation policy before confirming.
Only confirm when the user has clearly approved. Use a new UUID idempotency_key per action and reuse it when retrying the same call.`;

/** Virtual clock: starts at the task's `now` and advances in real time; can be pushed forward. */
export class OffsetClock implements Clock {
  #offset: number;
  constructor(anchor: string | Date) {
    this.#offset = new Date(anchor).getTime() - Date.now();
  }
  now(): Date {
    return new Date(Date.now() + this.#offset);
  }
  advance(ms: number): void {
    this.#offset += ms;
  }
}

export interface RunOptions {
  /** Per-task wall-clock timeout. Default 180s. */
  timeoutMs?: number;
}

/** Run one task against one driver on a fresh, isolated server. */
export async function runTask(
  task: Task,
  driver: AgentDriver,
  options: RunOptions = {},
): Promise<TaskRunResult> {
  const clock = new OffsetClock(task.now);
  const provider = createDemoRestaurantProvider();
  const events: BookingEvent[] = [];
  let recording = false;
  const service = new BookingService({
    provider,
    clock,
    holdTtlSeconds: task.hold_ttl_seconds,
    onEvent: (e) => recording && events.push(e),
  });

  const setupIds = await applySetup(task, service);
  recording = true;

  const { app, close } = createOpenBookingApp({ service, baseUrl: 'http://127.0.0.1' });
  let toolCalls = 0;
  let injected = false;
  const server = await listen(
    {
      fetch: async (req) => {
        if (req.method === 'POST' && new URL(req.url).pathname === '/mcp') {
          const body = await req.clone().text();
          if (body.includes('"tools/call"')) toolCalls++;
          const advance = task.inject.advance_clock_before_first_confirm_seconds;
          if (advance && !injected && /"name"\s*:\s*"confirm_booking"/.test(body)) {
            injected = true;
            clock.advance(advance * 1000);
          }
        }
        return app.fetch(req);
      },
    },
    { port: 0 },
  );

  const started = Date.now();
  let driverError: string | undefined;
  try {
    await driver.run({
      task,
      mcpUrl: `http://127.0.0.1:${server.port}/mcp`,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    });
  } catch (e) {
    driverError = e instanceof Error ? e.message : String(e);
  } finally {
    await close();
    await server.close();
  }

  return evaluate(
    task,
    driver.name,
    provider,
    clock,
    events,
    setupIds,
    toolCalls,
    Date.now() - started,
    driverError,
  );
}

export async function runBenchmark(
  tasks: Task[],
  drivers: AgentDriver[],
  options: RunOptions & { onResult?: (r: TaskRunResult) => void } = {},
): Promise<{ results: TaskRunResult[]; summary: DriverSummary[] }> {
  const results: TaskRunResult[] = [];
  for (const driver of drivers) {
    for (const task of tasks) {
      const r = await runTask(task, driver, options);
      options.onResult?.(r);
      results.push(r);
    }
  }
  return { results, summary: summarize(results) };
}

export function summarize(results: TaskRunResult[]): DriverSummary[] {
  const byDriver = new Map<string, TaskRunResult[]>();
  for (const r of results) byDriver.set(r.driver, [...(byDriver.get(r.driver) ?? []), r]);
  return [...byDriver].map(([driver, rs]) => ({
    driver,
    tasks: rs.length,
    completion_rate: rs.filter((r) => r.success).length / rs.length,
    double_bookings: rs.reduce((n, r) => n + r.double_bookings, 0),
    expired_hold_errors: rs.reduce((n, r) => n + r.expired_hold_errors, 0),
    avg_tool_calls: rs.reduce((n, r) => n + r.tool_calls, 0) / rs.length,
  }));
}

async function applySetup(task: Task, service: BookingService): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const s of task.setup) {
    const { slots } = await service.searchAvailability({
      date: s.date,
      party_size: { total: s.party_size },
      time_from: s.time,
      time_to: s.time,
      offering_id: s.offering_id,
    });
    if (!slots[0]) throw new Error(`Task ${task.id}: setup slot ${s.date} ${s.time} not available`);
    const hold = await service.hold({
      slot_id: slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Setup', last_name: 'Guest', email: 'setup@example.com' },
    });
    if (s.confirm) {
      await service.confirm({
        booking_id: hold.booking_id,
        idempotency_key: randomUUID(),
        user_confirmed: true,
        ...(hold.slot.deposit ? { payment_token: 'tok_setup' } : {}),
      });
    }
    ids.add(hold.booking_id);
  }
  return ids;
}

async function evaluate(
  task: Task,
  driver: string,
  provider: MemoryBookingProvider,
  clock: Clock,
  events: BookingEvent[],
  setupIds: Set<string>,
  toolCalls: number,
  durationMs: number,
  driverError: string | undefined,
): Promise<TaskRunResult> {
  const intent = task.intent;
  const venue = 'Europe/Oslo';
  const mine = (await provider.inspectBookings(clock.now())).filter(
    (b) => !setupIds.has(b.booking_id),
  );
  const confirmed = mine.filter((b) => b.status === 'confirmed');
  const cancelledAfterConfirm = mine.filter((b) => b.status === 'cancelled' && b.confirmed_at);

  const matches = (b: (typeof mine)[number]) => {
    const start = new Date(b.slot.start);
    const local = time.localTime(start, venue);
    return (
      time.localDate(start, venue) === intent.date &&
      b.slot.party_size.total === intent.party_size &&
      local >= intent.time_window[0] &&
      local <= intent.time_window[1] &&
      (!intent.offering_id || b.slot.offering.id === intent.offering_id) &&
      (intent.preferences ?? []).every((t) => b.slot.resource?.tags.includes(t))
    );
  };

  const outcome: TaskRunResult['outcome'] = confirmed.length
    ? 'confirmed'
    : cancelledAfterConfirm.length
      ? 'cancelled'
      : 'no_booking';
  const overlaps = (await provider.findOverlaps(clock.now())).length;
  const doubleBookings =
    Math.max(0, confirmed.length - task.expect.max_confirmed_bookings) + overlaps;

  const errorsByCode: Record<string, number> = {};
  for (const e of events)
    if (e.error_code) errorsByCode[e.error_code] = (errorsByCode[e.error_code] ?? 0) + 1;

  let failure: string | undefined;
  if (driverError) failure = `driver error: ${driverError}`;
  else if (outcome !== task.expect.outcome)
    failure = `expected outcome ${task.expect.outcome}, got ${outcome}`;
  else if (outcome === 'confirmed' && !confirmed.some(matches))
    failure = 'confirmed booking does not match the request';
  else if (outcome === 'cancelled' && !cancelledAfterConfirm.some(matches))
    failure = 'cancelled booking does not match the request';
  else if (doubleBookings > 0) failure = `${doubleBookings} double booking(s)`;

  return {
    task_id: task.id,
    driver,
    success: failure === undefined,
    ...(failure ? { failure_reason: failure } : {}),
    outcome,
    confirmed_bookings: confirmed.length,
    double_bookings: doubleBookings,
    expired_hold_errors: errorsByCode.hold_expired ?? 0,
    tool_calls: toolCalls,
    errors_by_code: errorsByCode,
    duration_ms: durationMs,
    ...(driverError ? { driver_error: driverError } : {}),
  };
}
