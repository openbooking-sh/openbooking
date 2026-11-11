import { describe, expect, it } from 'vitest';
import {
  BookingError,
  BookingService,
  ManualClock,
  MemoryIdempotencyStore,
  MemoryWaitlistStore,
  Waitlist,
  type Booking,
  type WaitlistEvent,
} from '../src';
import { DATE, DayProvider } from './day-provider';
import { CUSTOMER, VENUE } from './fixtures';
import { describeWaitlistStore } from './waitlist-store-contract';

describeWaitlistStore('memory', async () => new MemoryWaitlistStore());

const NOW = '2026-10-01T12:00:00Z';

const ada = { ...CUSTOMER, email: 'ada@example.com' };
const bob = { first_name: 'Bob', last_name: 'Builder', email: 'bob@example.com' };
const cy = { first_name: 'Cy', last_name: 'Young', email: 'cy@example.com' };

function setup(options: { provider?: DayProvider; offerTtlSeconds?: number } = {}) {
  const clock = new ManualClock(NOW);
  const provider = options.provider ?? new DayProvider();
  const service = new BookingService({ provider, clock });
  const store = new MemoryWaitlistStore();
  const events: WaitlistEvent[] = [];
  const waitlist = new Waitlist({
    service,
    store,
    offerTtlSeconds: options.offerTtlSeconds ?? 900,
    onEvent: (e) => events.push(e),
    onError: (e) => {
      throw e;
    },
  });
  let n = 0;
  const key = () => `key-${String(++n).padStart(6, '0')}`;
  const join = (customer = ada, over: Record<string, unknown> = {}) =>
    waitlist.join({
      date: DATE,
      party_size: 2,
      customer,
      user_confirmed: true,
      idempotency_key: key(),
      ...over,
    });
  /** Someone else books a slot (held, then confirmed), so it is no longer bookable. */
  const book = async (slotId: string) => {
    const held = await service.hold({ slot_id: slotId, idempotency_key: key(), customer: bob });
    return service.confirm({
      booking_id: held.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
  };
  const cancel = (b: Booking) =>
    service.cancel({ booking_id: b.booking_id, idempotency_key: key(), user_confirmed: true });
  return { clock, provider, service, store, waitlist, events, join, book, cancel, key };
}

/** Both evening slots taken. */
async function fullDay(s: ReturnType<typeof setup>) {
  return { b19: await s.book('s19'), b21: await s.book('s21') };
}

describe('joining', () => {
  it('is refused while something is bookable, and says what to book', async () => {
    const { join } = setup();
    const err = await join().catch((e) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect(err.code).toBe('invalid_state');
    expect(err.suggested_next_action).toContain('hold_slot');
    expect(err.details.slots.map((s: { slot_id: string }) => s.slot_id)).toEqual(['s19', 's21']);
  });

  it('is allowed for a full window even when other times are free', async () => {
    const s = setup();
    await s.book('s19');
    // The 19:00 window is full, 21:00 is free.
    const entry = await s.join(ada, { time_from: '19:00', time_to: '19:30' });
    expect(entry).toMatchObject({ status: 'waiting', time_from: '19:00', venue_id: VENUE.id });
    const err = await s.join(ada, { time_from: '20:00' }).catch((e) => e);
    expect(err.code).toBe('invalid_state');
  });

  it('needs the customer to agree, and records that they did', async () => {
    const s = setup();
    await fullDay(s);
    const refused = await s.join(ada, { user_confirmed: false }).catch((e) => e);
    expect(refused.code).toBe('user_confirmation_required');
    expect(await s.store.list()).toHaveLength(0);

    const entry = await s.join(ada);
    expect(entry.consent).toEqual({
      user_confirmed: true,
      at: new Date(NOW).toISOString(),
      agent: null,
      purpose: 'offer_notification_and_hold',
    });
    expect(entry.expires_at).toBe('2026-10-11T00:00:00+00:00');
  });

  it('refuses the past, unknown input, and too many open entries for one contact', async () => {
    const s = setup();
    await fullDay(s);
    expect((await s.join(ada, { date: '2026-09-30' }).catch((e) => e)).code).toBe(
      'validation_error',
    );
    expect((await s.join(ada, { party_size: 0 }).catch((e) => e)).code).toBe('validation_error');
    expect((await s.join(ada, { time_from: '22:00', time_to: '21:00' }).catch((e) => e)).code).toBe(
      'validation_error',
    );
    for (let i = 0; i < 5; i++) await s.join(ada);
    const err = await s.join({ ...ada, email: 'ADA@example.com' }).catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(await s.join(bob)).toMatchObject({ status: 'waiting' });
  });

  it('is idempotent: the same key joins once, and a different request on it conflicts', async () => {
    const s = setup();
    await fullDay(s);
    const args = {
      date: DATE,
      party_size: 2,
      customer: ada,
      user_confirmed: true,
      idempotency_key: 'join-key-0001',
    };
    const first = await s.waitlist.join(args);
    const again = await s.waitlist.join(args);
    expect(again.waitlist_id).toBe(first.waitlist_id);
    expect(await s.store.list()).toHaveLength(1);
    const both = await Promise.all([s.waitlist.join(args), s.waitlist.join(args)]);
    expect(both.map((e) => e.waitlist_id)).toEqual([first.waitlist_id, first.waitlist_id]);
    expect(await s.store.list()).toHaveLength(1);
    const conflict = await s.waitlist.join({ ...args, party_size: 3 }).catch((e) => e);
    expect(conflict.code).toBe('idempotency_conflict');
  });

  it('leaving is idempotent and frees the place', async () => {
    const s = setup();
    await fullDay(s);
    const entry = await s.join(ada);
    const key = s.key();
    const left = await s.waitlist.leave({ waitlist_id: entry.waitlist_id, idempotency_key: key });
    expect(left.status).toBe('cancelled');
    const again = await s.waitlist.leave({ waitlist_id: entry.waitlist_id, idempotency_key: key });
    expect(again.status).toBe('cancelled');
    expect(s.events.map((e) => e.type)).toEqual(['joined', 'left']);
    const unknown = await s.waitlist
      .leave({ waitlist_id: 'wl_nope', idempotency_key: s.key() })
      .catch((e) => e);
    expect(unknown.code).toBe('not_found');
  });
});

describe('offers', () => {
  it('holds the freed slot for the first in line and says so, leaving the rest waiting', async () => {
    const s = setup({ offerTtlSeconds: 600 });
    const { b19 } = await fullDay(s);
    const first = await s.join(ada);
    const second = await s.join(bob);

    await s.cancel(b19);
    await s.waitlist.idle();

    const offered = await s.store.get(first.waitlist_id);
    expect(offered?.status).toBe('offered');
    expect(offered?.offer?.booking_id).toBeTruthy();
    expect((await s.store.get(second.waitlist_id))?.status).toBe('waiting');

    // A real hold, on the freed slot, in the customer's name, for the offer window.
    const hold = await s.service.getBooking(offered!.offer!.booking_id!);
    expect(hold).toMatchObject({
      status: 'held',
      customer: { email: 'ada@example.com' },
      slot: { slot_id: 's19' },
      expires_at: '2026-10-01T12:10:00.000Z',
    });
    expect(offered?.offer?.expires_at).toBe(hold.expires_at);
    // So nobody else can book it meanwhile.
    expect(
      (await s.service.searchAvailability({ date: DATE, party_size: { total: 2 } })).slots,
    ).toEqual([]);

    const event = s.events.find((e) => e.type === 'offered')!;
    expect(event.entry.waitlist_id).toBe(first.waitlist_id);
    expect(event.booking?.booking_id).toBe(hold.booking_id);
  });

  it('serves the first entry that fits: service and time window count', async () => {
    const s = setup();
    const { b19 } = await fullDay(s);
    const wrongService = await s.join(ada, { offering_id: 'brunch' });
    const wrongTime = await s.join(bob, { time_from: '21:00' });
    const fits = await s.join(cy, { time_from: '19:00', time_to: '20:00' });
    // 'brunch' is unknown to a provider without offerings, so it is accepted; the slot is dinner.
    await s.cancel(b19);
    await s.waitlist.idle();
    expect((await s.store.get(wrongService.waitlist_id))?.status).toBe('waiting');
    expect((await s.store.get(wrongTime.waitlist_id))?.status).toBe('waiting');
    expect((await s.store.get(fits.waitlist_id))?.status).toBe('offered');
  });

  it('never confirms by itself: accepting is a normal confirm that needs user_confirmed', async () => {
    const s = setup();
    const { b19 } = await fullDay(s);
    const entry = await s.join(ada);
    await s.cancel(b19);
    await s.waitlist.idle();
    const holdId = (await s.store.get(entry.waitlist_id))!.offer!.booking_id!;
    expect((await s.service.getBooking(holdId)).status).toBe('held');

    const refused = await s.service
      .confirm({ booking_id: holdId, idempotency_key: s.key(), user_confirmed: false })
      .catch((e) => e);
    expect(refused.code).toBe('user_confirmation_required');
    expect((await s.store.get(entry.waitlist_id))?.status).toBe('offered');

    await s.service.confirm({ booking_id: holdId, idempotency_key: s.key(), user_confirmed: true });
    await s.waitlist.idle();
    expect((await s.store.get(entry.waitlist_id))?.status).toBe('accepted');
    expect(s.events.map((e) => e.type)).toEqual(['joined', 'offered', 'accepted']);
  });

  it('passes a lapsed offer to the next entry', async () => {
    const s = setup({ offerTtlSeconds: 600 });
    const { b19 } = await fullDay(s);
    const first = await s.join(ada);
    const second = await s.join(bob);
    await s.cancel(b19);
    await s.waitlist.idle();

    s.clock.advanceSeconds(601);
    await s.waitlist.sweep();

    expect((await s.store.get(first.waitlist_id))?.status).toBe('expired');
    const next = await s.store.get(second.waitlist_id);
    expect(next?.status).toBe('offered');
    expect(next?.offer?.expires_at).toBe('2026-10-01T12:20:01.000Z');
    expect(s.events.map((e) => e.type)).toEqual([
      'joined',
      'joined',
      'offered',
      'lapsed',
      'offered',
    ]);
    // The first customer's hold is gone and the slot is held by the second, not both.
    const holds = [...s.provider.bookings.values()].filter(
      (b) => b.status === 'held' && new Date(b.expires_at!) > s.clock.now(),
    );
    expect(holds).toHaveLength(1);
    expect(holds[0]!.customer?.email).toBe('bob@example.com');
  });

  it('passes a declined offer on, whether released or left', async () => {
    const s = setup();
    const { b19, b21 } = await fullDay(s);
    const first = await s.join(ada);
    const second = await s.join(bob);
    const third = await s.join(cy);
    await s.cancel(b19);
    await s.waitlist.idle();

    // Ada releases the hold through the normal tool.
    const hold = (await s.store.get(first.waitlist_id))!.offer!.booking_id!;
    await s.service.cancel({ booking_id: hold, idempotency_key: s.key() });
    await s.waitlist.idle();
    expect((await s.store.get(first.waitlist_id))?.status).toBe('declined');
    expect((await s.store.get(second.waitlist_id))?.status).toBe('offered');

    // Bob leaves the list instead: the slot goes on to Cy.
    const left = await s.waitlist.leave({
      waitlist_id: second.waitlist_id,
      idempotency_key: s.key(),
    });
    await s.waitlist.idle();
    expect(left.status).toBe('declined');
    expect((await s.store.get(third.waitlist_id))?.status).toBe('offered');
    void b21;
  });

  it('also reacts to a hold that lapsed on its own', async () => {
    const s = setup({ offerTtlSeconds: 600 });
    const held = await s.service.hold({ slot_id: 's19', idempotency_key: s.key(), customer: bob });
    await s.book('s21');
    const entry = await s.join(ada, { time_from: '19:00', time_to: '19:00' });
    s.clock.advanceSeconds(s.service.holdTtlSeconds + 1);
    // Nothing happens until someone notices the expiry; the sweep does.
    await s.waitlist.sweep();
    expect((await s.store.get(entry.waitlist_id))?.status).toBe('offered');
    void held;
  });
});

describe('races', () => {
  it('two cancellations at once offer the one waiting entry exactly one slot', async () => {
    const s = setup();
    const { b19, b21 } = await fullDay(s);
    const entry = await s.join(ada);
    await Promise.all([s.cancel(b19), s.cancel(b21)]);
    await s.waitlist.idle();

    const stored = await s.store.get(entry.waitlist_id);
    expect(stored?.status).toBe('offered');
    const holds = [...s.provider.bookings.values()].filter((b) => b.status === 'held');
    expect(holds).toHaveLength(1);
    expect(s.events.filter((e) => e.type === 'offered')).toHaveLength(1);
  });

  it('two cancellations at once serve two entries, one slot each', async () => {
    const s = setup();
    const { b19, b21 } = await fullDay(s);
    const first = await s.join(ada);
    const second = await s.join(bob);
    await Promise.all([s.cancel(b19), s.cancel(b21)]);
    await s.waitlist.idle();

    const [a, b] = await Promise.all([
      s.store.get(first.waitlist_id),
      s.store.get(second.waitlist_id),
    ]);
    expect([a?.status, b?.status]).toEqual(['offered', 'offered']);
    expect(a!.offer!.booking_id).not.toBe(b!.offer!.booking_id);
    const slots = [...s.provider.bookings.values()]
      .filter((x) => x.status === 'held')
      .map((x) => x.slot.slot_id)
      .sort();
    expect(slots).toEqual(['s19', 's21']);
  });

  it('two instances handed the same freed slot make one offer', async () => {
    const provider = new DayProvider();
    const shared = new MemoryWaitlistStore();
    const idempotency = new MemoryIdempotencyStore();
    const clock = new ManualClock(NOW);
    const make = () => {
      const service = new BookingService({ provider, clock, idempotencyStore: idempotency });
      // Not listening: the test hands both instances the freed slot at the same moment.
      const waitlist = new Waitlist({ service, store: shared, idempotencyStore: idempotency });
      waitlist.close();
      return { service, waitlist };
    };
    const one = make();
    const two = make();
    const book = async (slotId: string) => {
      const held = await one.service.hold({
        slot_id: slotId,
        idempotency_key: `book-${slotId}-hold`,
        customer: bob,
      });
      return one.service.confirm({
        booking_id: held.booking_id,
        idempotency_key: `book-${slotId}-conf`,
        user_confirmed: true,
      });
    };
    const b19 = await book('s19');
    await book('s21');
    const join = (customer: typeof ada, i: number) =>
      one.waitlist.join({
        date: DATE,
        party_size: 2,
        customer,
        user_confirmed: true,
        idempotency_key: `join-${i}-key`,
      });
    await join(ada, 1);
    await join(bob, 2);
    const freed = await one.service.cancel({
      booking_id: b19.booking_id,
      idempotency_key: 'cancel-19-key',
      user_confirmed: true,
    });

    const results = await Promise.all([
      one.waitlist.offerFreed(freed.booking),
      two.waitlist.offerFreed(freed.booking),
      one.waitlist.offerFreed(freed.booking),
      two.waitlist.offerFreed(freed.booking),
    ]);
    // One slot freed, so one entry has an offer, however the four calls interleaved.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect([...provider.bookings.values()].filter((x) => x.status === 'held')).toHaveLength(1);
    const offered = await shared.list({ status: ['offered'] });
    expect(offered).toHaveLength(1);
    expect(offered[0]!.customer.email).toBe('ada@example.com'); // first in line
    expect(await shared.list({ status: ['waiting'] })).toHaveLength(1);
  });

  it('an entry never holds two slots, however many slots free up', async () => {
    const s = setup();
    const { b19, b21 } = await fullDay(s);
    const entry = await s.join(ada);
    await s.cancel(b19);
    await s.waitlist.idle();
    await s.cancel(b21);
    await s.waitlist.idle();
    expect((await s.store.get(entry.waitlist_id))?.status).toBe('offered');
    expect([...s.provider.bookings.values()].filter((b) => b.status === 'held')).toHaveLength(1);
    // The second slot is simply bookable again.
    expect(
      (await s.service.searchAvailability({ date: DATE, party_size: { total: 2 } })).slots.map(
        (x) => x.slot_id,
      ),
    ).toEqual(['s21']);
  });
});

describe('customer data', () => {
  it('exports and erases a customer, releasing a slot held for them', async () => {
    const s = setup();
    const { b19 } = await fullDay(s);
    const mine = await s.join(ada);
    const theirs = await s.join(bob);
    await s.cancel(b19);
    await s.waitlist.idle();
    expect((await s.store.get(mine.waitlist_id))?.status).toBe('offered');

    expect(
      (await s.waitlist.exportCustomer({ email: 'ADA@example.com' })).map((e) => e.waitlist_id),
    ).toEqual([mine.waitlist_id]);
    expect(await s.waitlist.eraseCustomer({ email: 'ada@example.com' })).toBe(1);
    await s.waitlist.idle();

    expect(await s.store.get(mine.waitlist_id)).toBeUndefined();
    expect(await s.waitlist.exportCustomer({ email: 'ada@example.com' })).toEqual([]);
    // Her hold was released, so the slot went on to Bob.
    expect((await s.store.get(theirs.waitlist_id))?.status).toBe('offered');
    expect(
      [...s.provider.bookings.values()]
        .filter((b) => b.status === 'held')
        .map((b) => b.customer?.email),
    ).toEqual(['bob@example.com']);
  });

  it('retires entries after the day and deletes finished ones after the retention window', async () => {
    const s = setup();
    await fullDay(s);
    const entry = await s.join(ada);
    s.clock.set('2026-10-11T00:00:01Z');
    expect(await s.waitlist.sweep()).toBe(0);
    expect((await s.store.get(entry.waitlist_id))?.status).toBe('expired');
    s.clock.set('2026-11-12T00:00:00Z'); // 30 days later
    expect(await s.waitlist.sweep()).toBe(1);
    expect(await s.store.get(entry.waitlist_id)).toBeUndefined();
  });
});
