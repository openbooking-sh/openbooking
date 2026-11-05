import { describe, expect, it } from 'vitest';
import type { ConsentEvidence } from '@openbooking-sh/core';
import { ActivityStore, toActivityEntry } from '../src';

const consent: ConsentEvidence = {
  user_confirmed: true,
  terms: {
    start: '2026-10-10T19:00:00+00:00',
    end: '2026-10-10T20:30:00+00:00',
    party_size: 2,
    offering: 'Dinner',
    price: { amount: 65000, currency: 'NOK' },
    deposit: null,
    cancellation_policy: {
      refundability: 'refundable',
      description: 'Free cancellation until 24h before.',
      free_cancellation_until: '2026-10-09T19:00:00+00:00',
      late_cancellation_fee: { amount: 20000, currency: 'NOK' },
      no_show_fee: null,
    },
  },
};

describe('activity entries with consent evidence', () => {
  it('carry the evidence from the event, with the agent and time', async () => {
    const entry = toActivityEntry({
      operation: 'confirm',
      ok: true,
      at: '2026-10-01T12:05:00.000Z',
      booking_id: 'b1',
      status: 'confirmed',
      actor: { protocol: 'mcp', agent: 'Claude' },
      consent,
    });
    expect(entry).toMatchObject({ agent: 'Claude', at: '2026-10-01T12:05:00.000Z', consent });

    const log = new ActivityStore();
    await log.add(entry);
    const [stored] = await log.list({ booking_id: 'b1' });
    expect(stored!.consent?.terms.cancellation_policy.description).toBe(
      'Free cancellation until 24h before.',
    );
  });

  it('leave the field out when no consent was given', () => {
    const entry = toActivityEntry({
      operation: 'hold',
      ok: true,
      at: '2026-10-01T12:00:00.000Z',
      booking_id: 'b1',
    });
    expect('consent' in entry).toBe(false);
  });
});
