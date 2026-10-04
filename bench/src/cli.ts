/**
 * pnpm bench [--driver scripted] [--tasks bench/tasks] [--filter <id substring>] [--out bench/results]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ScriptedDriver } from './drivers/scripted';
import { runBenchmark } from './runner';
import { loadTasks } from './tasks';
import type { AgentDriver } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    driver: { type: 'string', multiple: true, default: ['scripted'] },
    tasks: { type: 'string', default: join(here, '..', 'tasks') },
    filter: { type: 'string' },
    out: { type: 'string', default: join(here, '..', 'results') },
  },
});

/** Register LLM drivers here once implemented, e.g. `'claude': () => new LlmDriver(adapter)`. */
const DRIVERS: Record<string, () => AgentDriver> = {
  scripted: () => new ScriptedDriver(),
};

const drivers = values.driver.map((name) => {
  const make = DRIVERS[name];
  if (!make)
    throw new Error(`Unknown driver "${name}". Available: ${Object.keys(DRIVERS).join(', ')}`);
  return make();
});

let tasks = await loadTasks(resolve(values.tasks));
if (values.filter) tasks = tasks.filter((t) => t.id.includes(values.filter!));

const { results, summary } = await runBenchmark(tasks, drivers, {
  onResult: (r) =>
    console.log(
      `${r.success ? 'PASS' : 'FAIL'}  ${r.driver.padEnd(10)} ${r.task_id.padEnd(28)} ${r.failure_reason ?? ''}`,
    ),
});

console.log();
console.table(
  summary.map((s) => ({
    driver: s.driver,
    tasks: s.tasks,
    'completion %': Math.round(s.completion_rate * 100),
    'double bookings': s.double_bookings,
    'expired-hold errors': s.expired_hold_errors,
    'avg tool calls': s.avg_tool_calls.toFixed(1),
  })),
);

await mkdir(values.out, { recursive: true });
const file = join(values.out, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify({ summary, results }, null, 2));
console.log(`\nResults written to ${file}`);
