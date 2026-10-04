import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmDriver, ScriptedDriver, loadTasks, runBenchmark, runTask } from '../src';

const TASKS = join(import.meta.dirname, '..', 'tasks');

describe('benchmark harness', () => {
  it('loads every task file', async () => {
    const tasks = await loadTasks(TASKS);
    expect(tasks.length).toBeGreaterThanOrEqual(9);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  it('the scripted baseline solves every task with zero double bookings', async () => {
    const tasks = await loadTasks(TASKS);
    const { results, summary } = await runBenchmark(tasks, [new ScriptedDriver()]);
    const failures = results
      .filter((r) => !r.success)
      .map((r) => `${r.task_id}: ${r.failure_reason}`);
    expect(failures).toEqual([]);
    expect(summary[0]).toMatchObject({ completion_rate: 1, double_bookings: 0 });
    // The injected slow-user task must register exactly one expired-hold error.
    expect(results.find((r) => r.task_id === 'expired-hold-recovery')!.expired_hold_errors).toBe(1);
  }, 60_000);

  it('records driver failures instead of crashing', async () => {
    const [task] = await loadTasks(TASKS);
    const llm = new LlmDriver({
      id: 'stub',
      turn: async () => ({ type: 'final', text: '', message: null }),
    });
    const r = await runTask(task!, llm);
    expect(r.success).toBe(false);
    expect(r.driver_error).toContain('not implemented');
  });
});
