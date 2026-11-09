import { describe, expect, it } from 'vitest';
import {
  BookingService,
  ManualClock,
  MemoryGuestStore,
  MemoryIdempotencyStore,
  type BookingEvent,
  type IdempotencyStore,
} from '../src';
import { describeGuestStore } from './guest-store-contract';
import { TinyProvider } from './fixtures';

describeGuestStore('memory', async () => new MemoryGuestStore());

// A made-up allergy no other test or fixture contains, so any leak is unmistakable.
const SENTINEL = 'ZXQ-sentinel-peanut-allergy';
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup(options: { retentionDays?: number } = {}) {
  const clock = new ManualClock('2026-10-01T12:00:00Z');
  const guests = new MemoryGuestStore();
  const events: BookingEvent[] = [];
  const service = new BookingService({
    provider: new TinyProvider(),
    clock,
    guests,
    ...(options.retentionDays !== undefined
      ? { dietaryNoteRetentionDays: options.retentionDays }
      : {}),
    onEvent: (e) => events.push(e),
  });
  return { service, clock, guests, events };
}

describe('dietary notes', () => {
  it('are kept apart from the booking and never show up in what the engine returns or emits', async () => {
    const { service, guests, events } = setup();
    const held = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
      dietary_notes: SENTINEL,
    });
    const confirmed = await service.confirm({
      booking_id: held.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
    });
    const fetched = await service.getBooking(held.booking_id);

    // The note is stored, for staff...
    expect((await guests.dietaryNotes('v1', [held.booking_id])).get(held.booking_id)).toBe(
      SENTINEL,
    );
    // ...and nowhere a caller, a listener or a log could pick it up.
    expect(JSON.stringify([held, confirmed, fetched, events])).not.toContain(SENTINEL);
  });

  it('are not written to the idempotency store, which outlives them', async () => {
    const written: unknown[] = [];
    const inner = new MemoryIdempotencyStore();
    const spy: IdempotencyStore = {
      get: (k) => inner.get(k),
      set: async (k, r, ttl) => {
        written.push([k, r]);
        return inner.set(k, r, ttl);
      },
      ...(inner.claim ? { claim: (k, f, t) => inner.claim!(k, f, t) } : {}),
    };
    const service = new BookingService({ provider: new TinyProvider(), idempotencyStore: spy });
    await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
      dietary_notes: SENTINEL,
    });
    expect(written.length).toBeGreaterThan(0);
    expect(JSON.stringify(written)).not.toContain(SENTINEL);
  });

  it('are saved once when a hold is retried with the same key', async () => {
    const { service, guests } = setup();
    const a = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      dietary_notes: 'no nuts',
    });
    const b = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      dietary_notes: 'no nuts',
    });
    expect(b.booking_id).toBe(a.booking_id);
    expect((await guests.dietaryNotes('v1', [a.booking_id])).size).toBe(1);
  });

  it('can be added, changed and cleared on an update, which needs no provider support for them', async () => {
    const { service, guests } = setup();
    const held = await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' });
    const note = async () =>
      (await guests.dietaryNotes('v1', [held.booking_id])).get(held.booking_id);
    await service.update({
      booking_id: held.booking_id,
      idempotency_key: 'update-key-1',
      dietary_notes: 'gluten',
    });
    expect(await note()).toBe('gluten');
    await service.update({
      booking_id: held.booking_id,
      idempotency_key: 'update-key-2',
      dietary_notes: null,
    });
    expect(await note()).toBeUndefined();
    // Only a note: the provider is not asked to update anything.
    expect((service.provider as TinyProvider).calls.updateBooking).toBe(0);
  });

  it('are capped in length', async () => {
    const { service } = setup();
    await expect(
      service.hold({
        slot_id: 'slot-1',
        idempotency_key: 'hold-key-1',
        dietary_notes: 'x'.repeat(301),
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('go when the booking is cancelled', async () => {
    const { service, guests } = setup();
    const held = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      dietary_notes: SENTINEL,
    });
    await service.cancel({ booking_id: held.booking_id, idempotency_key: 'cancel-key-1' });
    expect((await guests.dietaryNotes('v1', [held.booking_id])).size).toBe(0);
  });

  it('are deleted after the visit, once the retention period has passed', async () => {
    const { service, clock, guests } = setup({ retentionDays: 2 });
    const held = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      dietary_notes: SENTINEL,
    });
    // The slot in the fixture ends 2026-10-10T20:30Z.
    clock.set('2026-10-12T20:00:00Z');
    expect(await service.purgeDietaryNotes()).toBe(0);
    expect((await guests.dietaryNotes('v1', [held.booking_id])).size).toBe(1);
    clock.set('2026-10-12T21:00:00Z');
    expect(await service.purgeDietaryNotes()).toBe(1);
    expect((await guests.dietaryNotes('v1', [held.booking_id])).size).toBe(0);
  });

  it('are kept for one day after the visit by default', async () => {
    const { service, clock } = setup();
    expect(service.dietaryNoteRetentionDays).toBe(1);
    await service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1', dietary_notes: 'x' });
    clock.set('2026-10-11T20:00:00Z');
    expect(await service.purgeDietaryNotes()).toBe(0);
    clock.set('2026-10-11T21:00:00Z');
    expect(await service.purgeDietaryNotes()).toBe(1);
  });
});

describe('old data', () => {
  it('a hold without a dietary note behaves exactly as before', async () => {
    const { service, guests } = setup();
    const held = await service.hold({
      slot_id: 'slot-1',
      idempotency_key: 'hold-key-1',
      customer: CUSTOMER,
      notes: 'window seat',
    });
    expect(held.notes).toBe('window seat');
    expect((await guests.dietaryNotes('v1', [held.booking_id])).size).toBe(0);
    await expect(
      service.update({ booking_id: held.booking_id, idempotency_key: 'update-key-9' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});
