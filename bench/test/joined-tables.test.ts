import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  MemoryBookingProvider,
  MemoryBookingStore,
  demoRestaurantConfig,
  type BookingRecord,
} from '@openbooking-sh/provider-memory';
import { ScriptedDriver, loadTasks, runTask, type AgentDriver, type Task } from '../src';

const TASKS = join(import.meta.dirname, '..', 'tasks');
const taskById = async (id: string): Promise<Task> => {
  const task = (await loadTasks(TASKS)).find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

type Slots = Array<Record<string, any>>;

/**
 * A store with a bug: next to every booking that occupies several tables it reports a second
 * booking on the joined table, at the same time, as if that table had been given out twice.
 * Only the scorer's view is wrong; the real provider would have refused it.
 */
class DoubleBookedJoinedTableStore extends MemoryBookingStore {
  override async list(...args: Parameters<MemoryBookingStore['list']>) {
    const records = await super.list(...args);
    const forged: BookingRecord[] = records.flatMap((r) =>
      (r.extra_resource_ids ?? []).slice(0, 1).map((extra) => ({
        ...r,
        booking: { ...r.booking, booking_id: `forged-${r.booking.booking_id}` },
        resource_id: extra,
        extra_resource_ids: [],
      })),
    );
    return [...records, ...forged];
  }
}

/** Searches once and reports what the agent would see, without booking anything. */
function probe(search: Record<string, unknown>, seen: { slots?: Slots }): AgentDriver {
  return {
    name: 'probe',
    async run(ctx) {
      const client = new Client({ name: 'probe', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcpUrl)));
      try {
        const res = await client.callTool({ name: 'search_availability', arguments: search });
        seen.slots = (res.structuredContent as { slots?: Slots }).slots ?? [];
      } finally {
        await client.close();
      }
      return {};
    },
  };
}

describe('restaurant tasks', () => {
  it('counts a booking on several tables against each table: the scorer catches a joined table given out twice', async () => {
    const task = await taskById('joined-tables');
    const leaky = () =>
      new MemoryBookingProvider(demoRestaurantConfig(), {
        store: new DoubleBookedJoinedTableStore(),
      });

    // The same run on a sound provider is clean, so the failure below is the forged overlap.
    const sound = await runTask(task, new ScriptedDriver());
    expect(sound).toMatchObject({ success: true, double_bookings: 0, confirmed_bookings: 1 });

    const broken = await runTask(task, new ScriptedDriver(), { createProvider: leaky });
    expect(broken.double_bookings).toBeGreaterThan(0);
    expect(broken.success).toBe(false);
    expect(broken.failure_reason).toMatch(/double booking/);
  });

  it('fails a booking on the wrong number of tables', async () => {
    const task = await taskById('no-join-needed');
    // The scripted driver books one table; a task that insists on two must not pass.
    const r = await runTask(
      { ...task, expect: { ...task.expect, tables: 2 } },
      new ScriptedDriver(),
    );
    expect(r.success).toBe(false);
    expect(r.failure_reason).toMatch(/2 table/);
  });

  it('joined-tables: the only slot at 19:00 is the joined pair', async () => {
    const task = await taskById('joined-tables');
    const seen: { slots?: Slots } = {};
    await runTask(
      task,
      probe(
        {
          date: '2026-10-03',
          party_size: 7,
          time_from: '19:00',
          time_to: '19:00',
          offering_id: 'dinner',
        },
        seen,
      ),
    );
    expect(seen.slots).toHaveLength(1);
    // Agents see the joined tables in the slot's resource text.
    expect(seen.slots![0]!.resource).toMatch(/Tables .* together/);
  });

  it('pacing-full-evening: tables are free at 19:00 but the cap hides it', async () => {
    const task = await taskById('pacing-full-evening');
    const seen: { slots?: Slots } = {};
    await runTask(
      task,
      probe(
        {
          date: '2026-10-03',
          party_size: 2,
          time_from: '19:00',
          time_to: '20:00',
          offering_id: 'dinner',
        },
        seen,
      ),
    );
    expect(seen.slots!.map((s) => s.start.slice(11, 16))).toEqual(['19:30', '20:00']);
  });

  it('table-time-by-party: 19:30 would end at 21:30 for six, not 21:00', async () => {
    const task = await taskById('table-time-by-party');
    const seen: { slots?: Slots } = {};
    await runTask(
      task,
      probe(
        {
          date: '2026-10-02',
          party_size: 6,
          time_from: '19:00',
          time_to: '20:00',
          offering_id: 'dinner',
        },
        seen,
      ),
    );
    expect(seen.slots!.map((s) => [s.start.slice(11, 16), s.end.slice(11, 16)])).toEqual([
      ['19:00', '21:00'],
      ['19:30', '21:30'],
      ['20:00', '22:00'],
    ]);
  });

  it('table-time-by-party: a booking that runs past the time the user gave fails the task', async () => {
    const task = await taskById('table-time-by-party');
    // An agent that assumed the 90-minute table time would take 19:30; the scorer must refuse it.
    const late: AgentDriver = {
      name: 'late',
      async run(ctx) {
        const client = new Client({ name: 'late', version: '0.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcpUrl)));
        try {
          const call = async (name: string, args: Record<string, unknown>) =>
            (await client.callTool({ name, arguments: args })).structuredContent as any;
          const { slots } = await call('search_availability', {
            date: '2026-10-02',
            party_size: 6,
            time_from: '19:30',
            time_to: '19:30',
            offering_id: 'dinner',
          });
          const held = await call('hold_slot', {
            slot_id: slots[0].slot_id,
            idempotency_key: randomUUID(),
            customer: task.intent.customer,
          });
          await call('confirm_booking', {
            booking_id: held.booking_id,
            user_confirmed: true,
            idempotency_key: randomUUID(),
            payment_token: 'tok_visa',
          });
        } finally {
          await client.close();
        }
        return {};
      },
    };
    const r = await runTask(task, late);
    expect(r.success).toBe(false);
    expect(r.failure_reason).toMatch(/does not match/);
  });

  it('walk-in-reserve: the day shows nothing online once the reserve is used', async () => {
    const task = await taskById('walk-in-reserve');
    const seen: { slots?: Slots } = {};
    await runTask(
      task,
      probe({ date: '2026-10-04', party_size: 2, time_from: '16:00', time_to: '20:00' }, seen),
    );
    expect(seen.slots).toEqual([]);

    // Control: the following Sunday, with no bookings, has the same hours open.
    const nextWeek: { slots?: Slots } = {};
    await runTask(
      task,
      probe({ date: '2026-10-11', party_size: 2, time_from: '16:00', time_to: '20:00' }, nextWeek),
    );
    expect(nextWeek.slots!.length).toBeGreaterThan(0);
  });
});
