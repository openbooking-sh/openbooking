import { describe, expect, it } from 'vitest';
import {
  BookingService,
  BookingSchema,
  ManualClock,
  runAsActor,
  type Actor,
} from '@openbooking-sh/core';
import { MemoryBookingProvider, demoSalonConfig } from '../src';

// Thursday 2026-10-01 08:00 Oslo time; the booked day is far enough ahead to move bookings.
const NOW = '2026-10-01T06:00:00Z';
const DAY = '2026-10-06';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup() {
  const provider = new MemoryBookingProvider(demoSalonConfig());
  return new BookingService({ provider, clock: new ManualClock(NOW) });
}

async function slotAt(service: BookingService, at: string, offering = 'haircut') {
  const { slots } = await service.searchAvailability({
    date: DAY,
    party_size: { total: 1 },
    offering_id: offering,
    time_from: at,
    time_to: at,
    tags: ['maria'],
  });
  return slots[0]!;
}

const CHANNELS: Array<[string, Actor]> = [
  ['mcp', { protocol: 'mcp', agent: 'ChatGPT', client: 'openai-mcp' }],
  ['ucp', { protocol: 'ucp', agent: 'Gemini', client: 'agent.google.com' }],
  ['a2a', { protocol: 'a2a', agent: 'Claude', client: 'claude-ai' }],
  ['usp', { protocol: 'usp', agent: 'x', client: 'platform.example' }],
  ['website', { protocol: 'web', agent: 'Booking page', client: 'Chrome' }],
  ['embed', { protocol: 'web', agent: 'Browser agent', channel: 'embed', client: 'Safari' }],
  ['phone', { protocol: 'studio', agent: 'Studio', channel: 'phone' }],
  ['walk_in', { protocol: 'studio', agent: 'Studio', channel: 'walk_in' }],
];

describe('booking source', () => {
  it('records the channel and the reported assistant name when the hold is made', async () => {
    const service = setup();
    const slot = await slotAt(service, '10:00');
    const held = await runAsActor(CHANNELS[0]![1], () =>
      service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-key-1' }),
    );
    expect(held.source).toEqual({ channel: 'mcp', agent: 'openai-mcp' });
    expect(BookingSchema.parse(held).source).toEqual(held.source);
  });

  it('never lets staff or the platform pose as an assistant', async () => {
    const service = setup();
    const slot = await slotAt(service, '10:00');
    const held = await runAsActor(
      { protocol: 'studio', agent: 'Studio', client: 'something', channel: 'phone' },
      () => service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-key-1' }),
    );
    expect(held.source).toEqual({ channel: 'phone' });
  });

  it('keeps the source through confirm, reschedule and cancel, whoever does them', async () => {
    const service = setup();
    const slot = await slotAt(service, '10:00');
    const held = await runAsActor(CHANNELS[0]![1], () =>
      service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-key-1' }),
    );
    const source = { channel: 'mcp', agent: 'openai-mcp' };

    // Another door for every later step: the booking still came in through the first.
    const confirmed = await runAsActor(CHANNELS[4]![1], () =>
      service.confirm({
        booking_id: held.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
        customer: CUSTOMER,
      }),
    );
    expect(confirmed.source).toEqual(source);

    const target = await slotAt(service, '14:00');
    const moved = await runAsActor(CHANNELS[6]![1], () =>
      service.reschedule({
        booking_id: held.booking_id,
        slot_id: target.slot_id,
        idempotency_key: 'move-key-1',
        user_confirmed: true,
      }),
    );
    expect(moved.source).toEqual(source);

    const cancelled = await runAsActor(CHANNELS[7]![1], () =>
      service.cancel({
        booking_id: held.booking_id,
        idempotency_key: 'cancel-key-1',
        user_confirmed: true,
      }),
    );
    expect(cancelled.booking.source).toEqual(source);
    expect((await service.getBooking(held.booking_id)).source).toEqual(source);
  });

  it('leaves the source out when nobody is identifiable ("unknown")', async () => {
    const service = setup();
    const slot = await slotAt(service, '10:00');
    const held = await service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-key-1' });
    expect(held.source).toBeUndefined();
    expect('source' in held).toBe(false);
  });

  it('a retry with the same key replays the first booking, source included', async () => {
    const service = setup();
    const slot = await slotAt(service, '10:00');
    const first = await runAsActor(CHANNELS[0]![1], () =>
      service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-key-1' }),
    );
    const again = await runAsActor(CHANNELS[4]![1], () =>
      service.hold({ slot_id: slot.slot_id, idempotency_key: 'hold-key-1' }),
    );
    expect(again.booking_id).toBe(first.booking_id);
    expect(again.source).toEqual(first.source);
  });
});

describe('the source never changes what a guest pays', () => {
  // The "Google tax" rule: the same slot has the same price, deposit and cancellation terms
  // whichever channel the guest comes through.
  it('gives identical price, deposit and cancellation terms through every channel', async () => {
    const service = setup();
    // Color & cut has a price, a deposit at confirmation and a stricter cancellation policy.
    const slot = await slotAt(service, '10:00', 'color-cut');
    expect(slot.price).not.toBeNull();
    expect(slot.deposit).not.toBeNull();

    const terms = async (actor: Actor | undefined) => {
      const run = <T>(fn: () => Promise<T>) => (actor ? runAsActor(actor, fn) : fn());
      const searched = await run(() =>
        service.searchAvailability({
          date: DAY,
          party_size: { total: 1 },
          offering_id: 'color-cut',
          time_from: '10:00',
          time_to: '10:00',
          tags: ['maria'],
        }),
      );
      const held = await run(() =>
        service.hold({ slot_id: slot.slot_id, idempotency_key: `hold-${Math.random()}` }),
      );
      // Release, so the next channel holds the very same slot.
      await run(() =>
        service.cancel({ booking_id: held.booking_id, idempotency_key: `rel-${Math.random()}` }),
      );
      const pick = (s: typeof slot) => ({
        price: s.price,
        deposit: s.deposit,
        cancellation_policy: s.cancellation_policy,
      });
      return { searched: pick(searched.slots[0]!), held: pick(held.slot) };
    };

    const baseline = await terms(undefined);
    expect(baseline.held).toEqual(baseline.searched);
    for (const [name, actor] of CHANNELS) {
      expect(await terms(actor), name).toEqual(baseline);
    }
    // And no channel-dependent price field exists to be filled in.
    expect(Object.keys(slot)).not.toContain('source');
    expect(JSON.stringify(slot)).not.toMatch(/fee_by_channel|channel_fee|commission/i);
  });
});
