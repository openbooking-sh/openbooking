import { describe, expect, it } from 'vitest';
import {
  BookingService,
  ManualClock,
  runAsActor,
  evaluateFlags,
  normalizeEmail,
  type Actor,
  type BookingServiceOptions,
  type Customer,
  type Slot,
} from '../src';
import { TinyProvider, slot } from './fixtures';

const NOW = '2026-10-01T12:00:00Z';
const HOUR = 3_600_000;

/** `n` bookable slots, `perDay` per day, starting 2026-10-10. */
function slots(n: number, perDay = 4): Slot[] {
  return Array.from({ length: n }, (_, i) => {
    const day = 10 + Math.floor(i / perDay);
    const hour = 10 + (i % perDay) * 2;
    const start = `2026-10-${day}T${hour}:00:00+00:00`;
    const end = new Date(Date.parse(start) + HOUR).toISOString().replace('.000Z', '+00:00');
    return slot({
      slot_id: `s${i}`,
      start,
      end,
      cancellation_policy: {
        refundability: 'refundable',
        description: 'Free cancellation until 24h before.',
        free_cancellation_until: '2026-10-05T00:00:00+00:00',
        late_cancellation_fee: null,
        no_show_fee: null,
      },
    });
  });
}

const person = (n: number, email = `person${n}@example.com`): Customer => ({
  first_name: `First${n}`,
  last_name: `Last${n}`,
  email,
});
const ADA: Customer = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const bot: Actor = { protocol: 'mcp', agent: 'Bot', client: 'scalper-bot' };
const studio: Actor = { protocol: 'studio', agent: 'Studio' };

let n = 0;
const key = () => `key-${++n}-abcdefgh`;

function setup(guard: BookingServiceOptions['guard'] | undefined, count = 12) {
  const clock = new ManualClock(NOW);
  const provider = new TinyProvider(slots(count));
  const service = new BookingService({ provider, clock, ...(guard ? { guard } : {}) });
  const hold = (i: number, customer?: Customer, actor?: Actor) => {
    const run = () =>
      service.hold({ slot_id: `s${i}`, idempotency_key: key(), ...(customer ? { customer } : {}) });
    return actor ? runAsActor(actor, run) : run();
  };
  const confirm = (id: string, customer?: Customer, actor?: Actor) => {
    const run = () =>
      service.confirm({
        booking_id: id,
        idempotency_key: key(),
        user_confirmed: true,
        ...(customer ? { customer } : {}),
      });
    return actor ? runAsActor(actor, run) : run();
  };
  return { service, provider, clock, hold, confirm };
}

describe('per-guest limits', () => {
  it('refuses the booking over the limit, releases that hold, and does not say where the line is', async () => {
    const { service, provider, hold, confirm } = setup({ guest: { maxActive: 2 } });
    const a = await hold(0, ADA);
    await confirm(a.booking_id);
    await hold(1, ADA);

    const error = await hold(2, ADA).catch((e) => e);
    expect(error).toMatchObject({ code: 'booking_limit_reached', retryable: false });
    expect(JSON.stringify(error.toJSON())).not.toMatch(/\b2\b|two|limit of/i);
    expect(error.suggested_next_action).toMatch(/contact the venue/i);
    // The refused hold does not keep blocking the slot.
    expect([...provider.bookings.values()].find((b) => b.slot.slot_id === 's2')?.status).toBe(
      'cancelled',
    );
    expect(
      (
        await service.searchAvailability({ date: '2026-10-10', party_size: { total: 2 } })
      ).slots.map((s) => s.slot_id),
    ).toContain('s2');
  });

  it('counts the same person under different spellings of their email and phone', async () => {
    const { hold } = setup({ guest: { maxActive: 1 } });
    await hold(0, { ...ADA, email: 'a.da+x@gmail.com' });
    await expect(hold(1, { ...ADA, email: 'ADA@gmail.com' })).rejects.toMatchObject({
      code: 'booking_limit_reached',
    });
    expect(normalizeEmail('A.Da+tag@googlemail.com')).toBe('ada@gmail.com');
    await hold(2, { ...ADA, email: undefined, phone_number: '+47 123 45 678' });
    await expect(
      hold(3, { ...ADA, email: 'other@example.com', phone_number: '+4712345678' }),
    ).rejects.toMatchObject({ code: 'booking_limit_reached' });
  });

  it('limits per day on its own', async () => {
    const { hold } = setup({ guest: { maxPerDay: 1 } });
    await hold(0, ADA);
    await expect(hold(1, ADA)).rejects.toMatchObject({ code: 'booking_limit_reached' });
    await expect(hold(4, ADA)).resolves.toMatchObject({ status: 'held' }); // next day
  });

  it('checks at confirm when the hold named nobody, before anything is booked', async () => {
    const { provider, hold, confirm } = setup({ guest: { maxActive: 1 } });
    await hold(0, ADA);
    const unnamed = await hold(1);
    await expect(confirm(unnamed.booking_id, ADA)).rejects.toMatchObject({
      code: 'booking_limit_reached',
    });
    expect(provider.calls.confirmHold).toBe(0);
    // The hold is still there for somebody else to confirm.
    await expect(confirm(unnamed.booking_id, person(1))).resolves.toMatchObject({
      status: 'confirmed',
    });
  });

  it('stops counting holds that lapse, and bookings that are cancelled or over', async () => {
    const { service, clock, hold, confirm } = setup({ guest: { maxActive: 1 } });
    await hold(0, ADA);
    await expect(hold(1, ADA)).rejects.toThrow();
    clock.advance(service.holdTtlSeconds * 1000 + 1);
    const b = await hold(1, ADA);
    await confirm(b.booking_id);
    await expect(hold(2, ADA)).rejects.toThrow();
    await service.cancel({
      booking_id: b.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    const c = await hold(2, ADA);
    await confirm(c.booking_id);
    clock.set('2026-10-10T20:00:00Z'); // s2 (10-10 14:00) is over
    await expect(hold(3, ADA)).resolves.toMatchObject({ status: 'held' });
  });

  it('holds under concurrency through the service', async () => {
    const { hold } = setup({ guest: { maxActive: 3 } });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => hold(i, ADA)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });

  it('does not limit the venue itself', async () => {
    const { hold } = setup({ guest: { maxActive: 1 } });
    await hold(0, ADA);
    await expect(hold(1, ADA, studio)).resolves.toMatchObject({ status: 'held' });
  });

  it('replays an idempotent retry without counting it twice', async () => {
    const { service } = setup({ guest: { maxActive: 1 } });
    const input = { slot_id: 's0', idempotency_key: 'same-key-12345', customer: ADA };
    const first = await service.hold(input);
    const again = await service.hold(input);
    expect(again.booking_id).toBe(first.booking_id);
  });
});

describe('per-agent limits', () => {
  it('limits open holds and active bookings of one agent, not of others', async () => {
    const { hold, confirm } = setup({ agent: { maxHolds: 2, maxActive: 3 } });
    const a = await hold(0, person(0), bot);
    await hold(1, person(1), bot);
    await expect(hold(2, person(2), bot)).rejects.toMatchObject({ code: 'booking_limit_reached' });
    await confirm(a.booking_id, undefined, bot);
    await hold(2, person(2), bot); // one hold fewer, so room for another
    await expect(hold(3, person(3), bot)).rejects.toMatchObject({ code: 'booking_limit_reached' });
    // Another assistant, and callers that cannot be told apart, are not affected.
    await hold(4, person(4), { protocol: 'mcp', agent: 'Claude', client: 'claude-ai' });
    await hold(5, person(5));
    await hold(6, person(6), { protocol: 'web', agent: 'Mozilla', client: 'Mozilla/5.0' });
  });

  it('keys on whatever identifyAgent returns, the hook for verified identity', async () => {
    const { hold } = setup({
      agent: { maxHolds: 1 },
      identifyAgent: (actor) => (actor.client === 'verified' ? 'verified:agent-7' : undefined),
    });
    // The self-reported name alone is not enough to be limited.
    await hold(0, person(0), bot);
    await hold(1, person(1), bot);
    const verified: Actor = { ...bot, client: 'verified' };
    await hold(2, person(2), verified);
    await expect(hold(3, person(3), verified)).rejects.toMatchObject({
      code: 'booking_limit_reached',
    });
  });
});

describe('name-bound bookings', () => {
  const guard = { nonTransferable: true } as const;

  it('refuses a new name on a booking, from agents, but not another spelling or the venue', async () => {
    const { service, hold, confirm } = setup(guard);
    const h = await hold(0, ADA);
    const b = await confirm(h.booking_id);
    const rename = (customer: Customer, actor?: Actor) => {
      const run = () =>
        service.update({ booking_id: b.booking_id, idempotency_key: key(), customer });
      return actor ? runAsActor(actor, run) : run();
    };
    await expect(rename(person(9), bot)).rejects.toMatchObject({ code: 'not_transferable' });
    // New contact details for the same person are fine; so is different capitalisation.
    await expect(
      rename({ ...ADA, first_name: 'ADA', email: 'new@example.com' }, bot),
    ).resolves.toMatchObject({ customer: { email: 'new@example.com' } });
    // The venue can hand it on.
    await expect(rename(person(9), studio)).resolves.toMatchObject({
      customer: { first_name: 'First9' },
    });
  });

  it('refuses another name at confirm than the hold was made for', async () => {
    const { hold, confirm } = setup(guard);
    const h = await hold(0, ADA);
    await expect(confirm(h.booking_id, person(3), bot)).rejects.toMatchObject({
      code: 'not_transferable',
    });
    await expect(confirm(h.booking_id, ADA, bot)).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('says so in the terms before booking, and on the hold and confirmation', async () => {
    const { service, hold, confirm } = setup(guard);
    const found = (
      await service.searchAvailability({ date: '2026-10-10', party_size: { total: 2 } })
    ).slots;
    expect(found[0]!.cancellation_policy.description).toMatch(/cannot be transferred/);
    const h = await hold(0, ADA);
    expect(h.slot.cancellation_policy.description).toMatch(/cannot be transferred/);
    const b = await confirm(h.booking_id);
    expect(b.slot.cancellation_policy.description).toMatch(/cannot be transferred/);
    // Said once, not once per read.
    expect(
      (await service.getBooking(b.booking_id)).slot.cancellation_policy.description.match(
        /cannot be transferred/g,
      ),
    ).toHaveLength(1);
  });
});

describe('old configuration', () => {
  it('behaves exactly as before without guard', async () => {
    const { service, provider, hold, confirm } = setup(undefined);
    for (let i = 0; i < 6; i++) await hold(i, ADA, bot);
    const h = [...provider.bookings.values()][0]!;
    const b = await confirm(h.booking_id, person(1), bot);
    expect(b.slot.cancellation_policy.description).toBe('Free cancellation until 24h before.');
    await service.update({ booking_id: b.booking_id, idempotency_key: key(), customer: person(2) });
    expect(await service.riskFlags([b.booking_id])).toEqual(new Map());
  });

  it('a guard with no limits set refuses nothing', async () => {
    const { hold } = setup({});
    for (let i = 0; i < 6; i++) await hold(i, ADA, bot);
  });
});

describe('broker-pattern flags', () => {
  it('flags one contact booking under many names, without refusing', async () => {
    const { service, hold, confirm } = setup({
      flags: { contact_many_names: { count: 3, window_hours: 24 } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const h = await hold(i, { ...person(i), email: 'broker@example.com' });
      ids.push((await confirm(h.booking_id)).booking_id);
    }
    const flags = await service.riskFlags(ids);
    expect([...flags.keys()]).toEqual([ids[2]]);
    expect(flags.get(ids[2]!)).toEqual(['contact_many_names']);
  });

  it('flags one agent booking under many names', async () => {
    const { service, hold } = setup({
      flags: { agent_many_names: { count: 4, window_hours: 24 } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await hold(i, person(i), bot)).booking_id);
    expect([...(await service.riskFlags(ids)).keys()]).toEqual([ids[3], ids[4]]);
  });

  it('flags repeated book-then-cancel', async () => {
    const { service, hold, confirm } = setup({
      flags: { contact_cancel_churn: { count: 2, window_hours: 24 } },
    });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const h = await hold(i, ADA);
      const b = await confirm(h.booking_id);
      await service.cancel({
        booking_id: b.booking_id,
        idempotency_key: key(),
        user_confirmed: true,
      });
      ids.push(b.booking_id);
    }
    const flags = await service.riskFlags(ids);
    expect(flags.get(ids[1]!)).toEqual(['contact_cancel_churn']);
    // Releasing a hold you never confirmed is not churn.
    const { service: s2, hold: h2 } = setup({
      flags: { contact_cancel_churn: { count: 2, window_hours: 24 } },
    });
    const released: string[] = [];
    for (let i = 0; i < 3; i++) {
      const h = await h2(i, ADA);
      await s2.cancel({ booking_id: h.booking_id, idempotency_key: key() });
      released.push(h.booking_id);
    }
    expect((await s2.riskFlags(released)).size).toBe(0);
  });

  it('can be switched off, and does not flag ordinary use', async () => {
    const off = setup({ flags: false });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await off.hold(i, { ...person(i), email: 'x@example.com' }, bot)).booking_id);
    }
    expect((await off.service.riskFlags(ids)).size).toBe(0);

    const normal = setup({});
    const h = await normal.hold(0, ADA, bot);
    const b = await normal.confirm(h.booking_id);
    await normal.service.cancel({
      booking_id: b.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    expect((await normal.service.riskFlags([b.booking_id])).size).toBe(0);
  });

  it('evaluateFlags is a pure function of the history', () => {
    const e = (over = {}) => ({
      booking_id: 'x',
      venue_id: 'v',
      day: 'd',
      start_ms: 0,
      end_ms: 1,
      status: 'held' as const,
      hold_expires_ms: null,
      guest_keys: ['e:1'],
      name_key: 'n:1',
      agent_key: 'a',
      created_ms: 100,
      cancelled_ms: null,
      cancelled_from: null,
      flags: [],
      ...over,
    });
    const now = new Date(100);
    expect(evaluateFlags(e(), [e()], [e()], {}, now)).toEqual([]);
    const names = [1, 2, 3].map((i) => e({ name_key: `n:${i}` }));
    expect(evaluateFlags(e(), [], names, {}, now)).toEqual(['contact_many_names']);
    expect(evaluateFlags(e(), [], names, { contact_many_names: false }, now)).toEqual([]);
  });
});
