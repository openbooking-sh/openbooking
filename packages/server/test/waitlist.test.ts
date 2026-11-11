/**
 * The waitlist over a real MCP handshake against the full app: a table is booked, an agent joins
 * the waitlist for it, the booking is cancelled, and the agent finds a hold it can confirm.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BookingService, ManualClock, Waitlist } from '@openbooking-sh/core';
import { MemoryBookingProvider, demoRestaurantVenue } from '@openbooking-sh/provider-memory';
import { createOpenBookingApp } from '../src';

const BASE = 'http://localhost:3000';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A restaurant with one table, so one booking fills the evening. */
function oneTableRestaurant() {
  const venue = demoRestaurantVenue();
  venue.resources = [
    {
      id: 't1',
      venue_id: venue.venue.id,
      kind: 'table',
      name: 'Table 1',
      capacity: { min: 1, max: 4 },
      tags: [],
    },
  ];
  venue.table_combinations = [];
  return new MemoryBookingProvider({ name: 'One table', venues: [venue] });
}

async function connect(withWaitlist: boolean) {
  const clock = new ManualClock('2026-10-01T08:00:00Z');
  const service = new BookingService({
    provider: oneTableRestaurant(),
    clock,
    holdTtlSeconds: 300,
  });
  const waitlist = withWaitlist ? new Waitlist({ service, offerTtlSeconds: 600 }) : undefined;
  const ob = createOpenBookingApp({
    service,
    baseUrl: BASE,
    ...(waitlist ? { waitlist } : {}),
  });
  cleanups.push(ob.close);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', new URL(url).host);
      return ob.app.fetch(new Request(url, { ...init, headers }));
    },
  });
  const client = new Client({ name: 'waitlist-test', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError === true, data: res.structuredContent as Record<string, any> };
  };
  return { client, call, waitlist, clock, service };
}

const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const WINDOW = { date: '2026-10-02', party_size: 2, time_from: '19:00', time_to: '19:00' };

describe('waitlist over MCP', () => {
  it('offers the tools only when the server has a waitlist', async () => {
    const off = await connect(false);
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain('join_waitlist');
    const on = await connect(true);
    const names = (await on.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['join_waitlist', 'check_waitlist', 'leave_waitlist']),
    );
    expect(on.client.getInstructions()).toContain('join_waitlist');
    expect(off.client.getInstructions()).not.toContain('join_waitlist');
  });

  it('join, cancellation, offer, confirm: the agent never confirms without the user', async () => {
    const { call, waitlist } = await connect(true);
    const book = async () => {
      const search = await call('search_availability', WINDOW);
      const hold = await call('hold_slot', {
        slot_id: search.data.slots[0].slot_id,
        idempotency_key: randomUUID(),
        customer: { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
      });
      return call('confirm_booking', {
        booking_id: hold.data.booking_id,
        idempotency_key: randomUUID(),
        user_confirmed: true,
      });
    };
    const graces = await book();
    expect(graces.data.status).toBe('confirmed');
    expect((await call('search_availability', WINDOW)).data.slots).toEqual([]);

    // Nobody can join for a time that is still bookable.
    const bookable = await call('join_waitlist', {
      ...WINDOW,
      time_from: '21:00',
      time_to: '21:00',
      customer: ada,
      user_confirmed: true,
      idempotency_key: randomUUID(),
    });
    expect(bookable.isError).toBe(true);
    expect(bookable.data.error).toMatchObject({ code: 'invalid_state' });
    expect(bookable.data.error.suggested_next_action).toContain('hold_slot');

    // The customer must agree, and must give an email address.
    const join = {
      ...WINDOW,
      customer: ada,
      user_confirmed: true,
      idempotency_key: randomUUID(),
    };
    const noConsent = await call('join_waitlist', { ...join, user_confirmed: false });
    expect(noConsent.data.error.code).toBe('user_confirmation_required');
    const noEmail = await call('join_waitlist', {
      ...join,
      customer: { first_name: 'Ada', last_name: 'L', phone_number: '+4712345678' },
    });
    expect(noEmail.data.error.code).toBe('validation_error');
    expect(noEmail.data.error.message).toContain('email');

    const joined = await call('join_waitlist', join);
    expect(joined.isError).toBe(false);
    expect(joined.data).toMatchObject({ status: 'waiting', offer: null, party_size: 2 });
    expect(joined.data.next_step).toContain('nothing is booked automatically');
    // A retry with the same key is the same entry.
    const retry = await call('join_waitlist', join);
    expect(retry.data.waitlist_id).toBe(joined.data.waitlist_id);

    // Grace cancels: the table is held for Ada, not booked.
    const cancelled = await call('cancel_booking', {
      booking_id: graces.data.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });
    expect(cancelled.data.status).toBe('cancelled');
    await waitlist!.idle();

    const offer = await call('check_waitlist', { waitlist_id: joined.data.waitlist_id });
    expect(offer.data.status).toBe('offered');
    expect(offer.data.offer).toMatchObject({ local_time: '19:00', party_size: 2 });
    expect(offer.data.offer.expires_in_seconds).toBe(600);
    expect(offer.data.next_step).toContain('explicitly approve');
    expect(offer.data.next_step).toContain(offer.data.offer.booking_id);
    expect((await call('search_availability', WINDOW)).data.slots).toEqual([]); // held

    const held = await call('get_booking', { booking_id: offer.data.offer.booking_id });
    expect(held.data).toMatchObject({ status: 'held', customer: { email: 'ada@example.com' } });

    const refused = await call('confirm_booking', {
      booking_id: offer.data.offer.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: false,
    });
    expect(refused.data.error.code).toBe('user_confirmation_required');
    const confirmed = await call('confirm_booking', {
      booking_id: offer.data.offer.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });
    expect(confirmed.data.status).toBe('confirmed');
    await waitlist!.idle();
    expect(
      (await call('check_waitlist', { waitlist_id: joined.data.waitlist_id })).data,
    ).toMatchObject({ status: 'accepted', offer: null });
  });

  it('leaving the list passes a held slot on, and is idempotent', async () => {
    const { call, waitlist } = await connect(true);
    const hold = await call('hold_slot', {
      slot_id: (await call('search_availability', WINDOW)).data.slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer: { first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com' },
    });
    const first = await call('join_waitlist', {
      ...WINDOW,
      customer: ada,
      user_confirmed: true,
      idempotency_key: randomUUID(),
    });
    const second = await call('join_waitlist', {
      ...WINDOW,
      customer: { first_name: 'Bob', last_name: 'B', email: 'bob@example.com' },
      user_confirmed: true,
      idempotency_key: randomUUID(),
    });
    await call('cancel_booking', {
      booking_id: hold.data.booking_id,
      idempotency_key: randomUUID(),
    });
    await waitlist!.idle();
    expect(
      (await call('check_waitlist', { waitlist_id: first.data.waitlist_id })).data.status,
    ).toBe('offered');

    const key = randomUUID();
    const left = await call('leave_waitlist', {
      waitlist_id: first.data.waitlist_id,
      idempotency_key: key,
    });
    expect(left.data.status).toBe('declined');
    await waitlist!.idle();
    const again = await call('leave_waitlist', {
      waitlist_id: first.data.waitlist_id,
      idempotency_key: key,
    });
    expect(again.data.status).toBe('declined');
    expect(
      (await call('check_waitlist', { waitlist_id: second.data.waitlist_id })).data.status,
    ).toBe('offered');
    const unknown = await call('check_waitlist', { waitlist_id: 'wl_nope' });
    expect(unknown.data.error.code).toBe('not_found');
  });
});
