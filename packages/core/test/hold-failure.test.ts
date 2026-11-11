import { describe, expect, it } from 'vitest';
import {
  BookingService,
  ManualClock,
  MemoryGuestStore,
  MemoryIdempotencyStore,
  type IdempotencyStore,
} from '../src';
import { CUSTOMER, TinyProvider } from './fixtures';

// A hold is made at the provider first; the dietary note and the idempotency record are written
// after it. When one of those writes fails the caller gets an error and retries with the same key,
// and that retry must not find the slot blocked by the hold of its own failed first try.

const HOLD = { slot_id: 'slot-1', idempotency_key: 'hold-key-1', customer: CUSTOMER };

const liveHolds = (provider: TinyProvider) =>
  [...provider.bookings.values()].filter((b) => b.status === 'held');

/** An idempotency store whose first `set` fails, as a database blip would. */
function failingOnce(inner: IdempotencyStore): IdempotencyStore {
  let failed = false;
  return {
    get: (k) => inner.get(k),
    claim: (k, f, t) => inner.claim!(k, f, t),
    release: (k) => inner.release!(k),
    set: async (k, r, t) => {
      if (!failed) {
        failed = true;
        throw new Error('idempotency store down');
      }
      return inner.set(k, r, t);
    },
  };
}

describe('a hold whose later step fails', () => {
  it('is released when the dietary note cannot be saved, so the same key can retry', async () => {
    const provider = new TinyProvider();
    const guests = new MemoryGuestStore();
    const save = guests.saveDietaryNote.bind(guests);
    let failed = false;
    guests.saveDietaryNote = async (note) => {
      if (!failed) {
        failed = true;
        throw new Error('guest store down');
      }
      return save(note);
    };
    const service = new BookingService({
      provider,
      guests,
      clock: new ManualClock('2026-10-01T12:00:00Z'),
    });
    const input = { ...HOLD, dietary_notes: 'no nuts' };

    await expect(service.hold(input)).rejects.toMatchObject({ code: 'provider_error' });
    expect(liveHolds(provider)).toHaveLength(0);

    const held = await service.hold(input);
    expect(held.status).toBe('held');
    expect(liveHolds(provider).map((b) => b.booking_id)).toEqual([held.booking_id]);
    expect((await guests.dietaryNotes('v1', [held.booking_id])).get(held.booking_id)).toBe(
      'no nuts',
    );

    // From here on the key replays: no third hold.
    expect((await service.hold(input)).booking_id).toBe(held.booking_id);
    expect(provider.calls.createHold).toBe(2);
  });

  it('is released when the idempotency record cannot be written, so the same key can retry', async () => {
    const provider = new TinyProvider();
    const guests = new MemoryGuestStore();
    const service = new BookingService({
      provider,
      guests,
      clock: new ManualClock('2026-10-01T12:00:00Z'),
      idempotencyStore: failingOnce(new MemoryIdempotencyStore()),
    });
    const input = { ...HOLD, dietary_notes: 'no nuts' };

    await expect(service.hold(input)).rejects.toMatchObject({ code: 'provider_error' });
    expect(liveHolds(provider)).toHaveLength(0);
    // The note of a hold that no longer exists is not kept either.
    expect((await guests.dietaryNotes('v1', ['b1'])).size).toBe(0);

    const held = await service.hold(input);
    expect(held.status).toBe('held');
    expect(liveHolds(provider).map((b) => b.booking_id)).toEqual([held.booking_id]);

    expect((await service.hold(input)).booking_id).toBe(held.booking_id);
    expect(provider.calls.createHold).toBe(2);
  });

  it('leaves exactly one hold when a second instance sends the same key meanwhile', async () => {
    // Two services on one provider and one idempotency store: two server instances, one database.
    const provider = new TinyProvider();
    const store = failingOnce(new MemoryIdempotencyStore());
    const clock = new ManualClock('2026-10-01T12:00:00Z');
    const a = new BookingService({ provider, clock, idempotencyStore: store });
    const b = new BookingService({ provider, clock, idempotencyStore: store });

    const [x, y] = await Promise.allSettled([a.hold(HOLD), b.hold(HOLD)]);

    expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected']);
    const held = x.status === 'fulfilled' ? x.value : y.status === 'fulfilled' ? y.value : null;
    expect(liveHolds(provider).map((h) => h.booking_id)).toEqual([held!.booking_id]);
    // Either instance now replays that one hold.
    expect((await a.hold(HOLD)).booking_id).toBe(held!.booking_id);
    expect((await b.hold(HOLD)).booking_id).toBe(held!.booking_id);
    expect(liveHolds(provider)).toHaveLength(1);
  });
});
