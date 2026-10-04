import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AgentDriver, DriverContext, DriverResult } from '../types';

/** Loose view of tool structuredContent (fields depend on the tool). */
interface ToolData {
  error: { code: string; message: string };
  slots: Array<{ slot_id: string }>;
  booking_id: string;
  deposit: { due: string } | null;
  confirmation_code: string;
}

type Call = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; data: ToolData }>;

/**
 * Deterministic baseline that follows the protocol perfectly using the task's structured intent.
 * It validates the harness and sets the ceiling LLM drivers are compared against.
 */
export class ScriptedDriver implements AgentDriver {
  readonly name = 'scripted';

  async run(ctx: DriverContext): Promise<DriverResult> {
    const client = new Client({ name: 'openbooking-bench-scripted', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcpUrl)));
    const transcript: unknown[] = [];
    const call: Call = async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      transcript.push({ name, args, result: res.structuredContent });
      return { ok: res.isError !== true, data: res.structuredContent as unknown as ToolData };
    };
    try {
      return { final_message: await this.#book(ctx, call), transcript };
    } finally {
      await client.close();
    }
  }

  async #book(ctx: DriverContext, call: Call): Promise<string> {
    const i = ctx.task.intent;
    const search = () =>
      call('search_availability', {
        date: i.date,
        party_size: i.party_size,
        time_from: i.time_window[0],
        time_to: i.time_window[1],
        ...(i.offering_id ? { offering_id: i.offering_id } : {}),
        ...(i.preferences?.length ? { preferences: i.preferences } : {}),
      });

    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await search();
      if (!s.ok) return `Sorry: ${s.data.error.message}`;
      const slot = s.data.slots[0];
      if (!slot) return 'Sorry, nothing is available in that window.';

      const hold = await call('hold_slot', {
        slot_id: slot.slot_id,
        idempotency_key: randomUUID(),
        customer: i.customer,
      });
      if (!hold.ok) {
        if (hold.data.error.code === 'slot_unavailable') continue;
        return `Sorry: ${hold.data.error.message}`;
      }

      // (A real agent shows hold.data.cancellation_policy / deposit to the user here.)
      const confirm = await call('confirm_booking', {
        booking_id: hold.data.booking_id,
        user_confirmed: true,
        idempotency_key: randomUUID(),
        ...(hold.data.deposit?.due === 'at_confirmation' && i.payment_token
          ? { payment_token: i.payment_token }
          : {}),
      });
      if (!confirm.ok) {
        if (confirm.data.error.code === 'hold_expired') continue;
        return `Sorry: ${confirm.data.error.message}`;
      }

      if (!i.then_cancel) return `Booked! Confirmation code ${confirm.data.confirmation_code}.`;

      const id = hold.data.booking_id;
      const cancelKey = randomUUID();
      const terms = await call('cancel_booking', { booking_id: id, idempotency_key: cancelKey });
      if (terms.ok) return 'Cancelled.';
      if (terms.data.error.code !== 'user_confirmation_required')
        return `Sorry: ${terms.data.error.message}`;
      // (A real agent relays the fee to the user here.) Same key: the first attempt changed nothing.
      const done = await call('cancel_booking', {
        booking_id: id,
        idempotency_key: cancelKey,
        user_confirmed: true,
      });
      return done.ok ? 'Cancelled.' : `Sorry: ${done.data.error.message}`;
    }
    return 'Sorry, I could not secure a slot.';
  }
}
