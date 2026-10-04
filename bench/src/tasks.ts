import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { TaskSchema, type Task } from './types';

/** Load and validate every `*.yaml` task in a directory, sorted by file name. */
export async function loadTasks(dir: string): Promise<Task[]> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const tasks: Task[] = [];
  for (const file of files) {
    const raw = parse(await readFile(join(dir, file), 'utf8')) as unknown;
    const result = TaskSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Invalid task ${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    tasks.push(result.data);
  }
  return tasks;
}
