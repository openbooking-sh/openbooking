import { describe, expect, it } from 'vitest';
import {
  BookingService,
  createWebhooks,
  ManualClock,
  runAsActor,
  type BookingEvent,
  type ExpiryClaims,
  type WebhookEvent,
} from '../src';
import { CUSTOMER, TinyProvider } from './fixtures';

const NOW = '2026-10-01T12:00:00Z';

class ListingProvider extends TinyProvider {
  async listBookings() {
    return [...this.bookings.values()].map((b) => structuredClone(b));
  }
}

/** A claim store two service instances can share, like a database table would be. */
class SharedClaims implements ExpiryClaims {
  readonly keys = new Set<string>();
  async claim(key: string) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

function setup(options: { claims?: ExpiryClaims; provider?: ListingProvider } = {}) {
  const clock = new ManualClock(NOW);
  const provider = options.provider ?? new ListingProvider();
  const service = new BookingService({
    provider,
    clock,
    ...(options.claims ? { expiryClaims: options.claims } : {}),
  });
  const expired: BookingEvent[] = [];
  service.on((e) => {
    if (e.operation === 'expire') expired.push(e);
  });
  return { clock, provider, service, expired };
}

const hold = (service: BookingService, key = 'hold-key-1') =>
  service.hold({ slot_id: 'slot-1', idempotency_key: key });

describe('expiry events', () => {
  it('emits once when a lapsed hold is noticed, however often it is read afterwards', async () => {
    const { clock, service, expired } = setup();
    const held = await hold(service);
    clock.advance(service.holdTtlSeconds * 1000 - 1);
    await service.getBooking(held.booking_id);
    expect(expired).toHaveLength(0);

    clock.advance(1);
    const seen = await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () =>
      service.getBooking(held.booking_id),
    );
    expect(seen.status).toBe('expired');
    await service.getBooking(held.booking_id);
    await service.listBookings();
    await service.sweepExpired();

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      operation: 'expire',
      ok: true,
      booking_id: held.booking_id,
      status: 'expired',
      at: held.expires_at,
      booking: { booking_id: held.booking_id, status: 'expired' },
    });
    // The clock expired it, not the agent whose read noticed.
    expect(expired[0]!.actor).toBeUndefined();
  });

  it('announces a lapse nobody reads when swept, and reports what the sweep announced', async () => {
    const { clock, service, expired } = setup();
    const a = await hold(service);
    expect(await service.sweepExpired()).toEqual([]);
    clock.advance(service.holdTtlSeconds * 1000);
    expect(await service.sweepExpired()).toEqual([a.booking_id]);
    expect(await service.sweepExpired()).toEqual([]);
    expect(expired.map((e) => e.booking_id)).toEqual([a.booking_id]);
  });

  it('never emits for a hold confirmed or cancelled in time', async () => {
    const { clock, service, expired } = setup({
      provider: new ListingProvider([
        // two slots so both holds can exist at once
        ...new TinyProvider().slots,
        { ...new TinyProvider().slots[0]!, slot_id: 'slot-2' },
      ]),
    });
    const confirmed = await hold(service, 'hold-key-1');
    const cancelled = await service.hold({ slot_id: 'slot-2', idempotency_key: 'hold-key-2' });
    await service.confirm({
      booking_id: confirmed.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
      customer: CUSTOMER,
    });
    await service.cancel({ booking_id: cancelled.booking_id, idempotency_key: 'cancel-key-1' });

    clock.advance(service.holdTtlSeconds * 1000 * 10);
    await service.getBooking(confirmed.booking_id);
    await service.getBooking(cancelled.booking_id);
    await service.listBookings();
    expect(await service.sweepExpired()).toEqual([]);
    expect(expired).toHaveLength(0);
  });

  it('emits once even when two instances sharing a store both notice, concurrently', async () => {
    const claims = new SharedClaims();
    const provider = new ListingProvider();
    const a = setup({ claims, provider });
    const b = setup({ claims, provider });
    // Same wall clock for both instances.
    const held = await hold(a.service);
    a.clock.advance(a.service.holdTtlSeconds * 1000);
    b.clock.advance(b.service.holdTtlSeconds * 1000);

    await Promise.all([
      a.service.getBooking(held.booking_id),
      b.service.getBooking(held.booking_id),
      a.service.sweepExpired(),
      b.service.sweepExpired(),
    ]);
    expect(a.expired.length + b.expired.length).toBe(1);
  });

  it('still stops blocking: an expired hold frees the slot and cannot be confirmed', async () => {
    const { clock, service, expired } = setup();
    const held = await hold(service);
    await expect(hold(service, 'hold-key-2')).rejects.toMatchObject({ code: 'slot_unavailable' });

    clock.advance(service.holdTtlSeconds * 1000);
    await service.sweepExpired();
    expect(expired).toHaveLength(1);
    await expect(
      service.confirm({
        booking_id: held.booking_id,
        idempotency_key: 'confirm-key-1',
        user_confirmed: true,
        customer: CUSTOMER,
      }),
    ).rejects.toMatchObject({ code: 'hold_expired' });
    await expect(hold(service, 'hold-key-3')).resolves.toMatchObject({ status: 'held' });
  });

  it('reads still work when the claim store fails, and nothing is emitted', async () => {
    const { clock, service, expired } = setup({
      claims: {
        claim: async () => {
          throw new Error('db down');
        },
      },
    });
    const held = await hold(service);
    clock.advance(service.holdTtlSeconds * 1000);
    await expect(service.getBooking(held.booking_id)).resolves.toMatchObject({
      status: 'expired',
    });
    expect(expired).toHaveLength(0);
  });

  it('is delivered as a signed booking.expired webhook, once, without an actor', async () => {
    const deliveries: WebhookEvent[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      deliveries.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { clock, service } = setup();
    const webhooks = createWebhooks({
      endpoints: [
        { url: 'https://crm.example/hooks', secret: 'whsec_test_0123456789' },
        {
          url: 'https://other.example/hooks',
          secret: 'whsec_test_0123456789',
          events: ['booking.confirmed'],
        },
      ],
      fetch,
    });
    service.on(webhooks.listener);
    const held = await hold(service);
    clock.advance(service.holdTtlSeconds * 1000);
    await service.getBooking(held.booking_id);
    await service.getBooking(held.booking_id);
    await webhooks.idle();

    expect(deliveries.map((d) => d.type)).toEqual(['booking.held', 'booking.expired']);
    const e = deliveries[1]!;
    expect(e.data.booking).toMatchObject({ booking_id: held.booking_id, status: 'expired' });
    expect(e.data.actor).toBeUndefined();
    expect(e.created_at).toBe(held.expires_at);
  });
});
