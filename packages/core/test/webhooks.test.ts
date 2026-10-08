import { describe, expect, it } from 'vitest';
import {
  BookingService,
  createWebhooks,
  runAsActor,
  signWebhook,
  verifyWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEvent,
} from '../src';
import { CUSTOMER, TinyProvider } from './fixtures';

const SECRET = 'whsec_test_0123456789';

interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: string;
  event: WebhookEvent;
}

/** A fake receiver: records deliveries and answers with the given statuses in turn (then 200). */
function receiver(statuses: number[] = []) {
  const deliveries: Delivery[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    deliveries.push({
      url,
      headers: init.headers as Record<string, string>,
      body,
      event: JSON.parse(body),
    });
    return new Response(null, { status: statuses.shift() ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { deliveries, fetch };
}

async function book(service: BookingService) {
  const hold = await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () =>
    service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' }),
  );
  await service.confirm({
    booking_id: hold.booking_id,
    idempotency_key: 'confirm-key-1',
    user_confirmed: true,
    customer: CUSTOMER,
  });
  return hold;
}

describe('webhooks', () => {
  it('sends signed held, confirmed and cancelled events, and nothing for replays or no-ops', async () => {
    const { deliveries, fetch } = receiver();
    const webhooks = createWebhooks({
      endpoints: [{ url: 'https://crm.example/hooks', secret: SECRET }],
      fetch,
    });
    const service = new BookingService({
      provider: new TinyProvider(),
      onEvent: webhooks.listener,
    });

    const hold = await book(service);
    // A retried confirm (same key) is a replay: no second event.
    await service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: 'confirm-key-1',
      user_confirmed: true,
      customer: CUSTOMER,
    });
    await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: 'cancel-key-1',
      user_confirmed: true,
    });
    // Cancelling again changes nothing: no event.
    await service.cancel({
      booking_id: hold.booking_id,
      idempotency_key: 'cancel-key-2',
      user_confirmed: true,
    });
    await service.getBooking(hold.booking_id);
    await webhooks.idle();

    expect(deliveries.map((d) => d.event.type)).toEqual([
      'booking.held',
      'booking.confirmed',
      'booking.cancelled',
    ]);
    const [held, confirmed] = deliveries;
    expect(held!.event.data.actor).toMatchObject({ agent: 'Claude' });
    expect(confirmed!.event.data.booking).toMatchObject({
      booking_id: hold.booking_id,
      status: 'confirmed',
    });
    expect(new Set(deliveries.map((d) => d.event.id)).size).toBe(3);
    for (const d of deliveries) {
      expect(d.headers[WEBHOOK_ID_HEADER]).toBe(d.event.id);
      expect(await verifyWebhook(d.body, d.headers[WEBHOOK_SIGNATURE_HEADER], SECRET)).toBe(true);
    }
  });

  it('verification rejects a tampered body, a wrong secret and an old signature', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'booking.confirmed' });
    const now = new Date('2026-10-07T12:00:00Z');
    const t = Math.floor(now.getTime() / 1000);
    const header = await signWebhook(body, SECRET, t);

    expect(await verifyWebhook(body, header, SECRET, { now })).toBe(true);
    expect(
      await verifyWebhook(body.replace('confirmed', 'cancelled'), header, SECRET, { now }),
    ).toBe(false);
    expect(await verifyWebhook(body, header, 'whsec_other_0123456789', { now })).toBe(false);
    const later = new Date(now.getTime() + 301_000);
    expect(await verifyWebhook(body, header, SECRET, { now: later })).toBe(false);
    expect(await verifyWebhook(body, null, SECRET, { now })).toBe(false);
    expect(await verifyWebhook(body, 'garbage', SECRET, { now })).toBe(false);
  });

  it('retries server errors with the same event id, and gives up on other 4xx', async () => {
    const flaky = receiver([500, 503]);
    const failures: string[] = [];
    const webhooks = createWebhooks({
      endpoints: [{ url: 'https://crm.example/hooks', secret: SECRET, events: ['booking.held'] }],
      fetch: flaky.fetch,
      retryDelaysMs: [0, 0, 0],
      onFailure: (f) => failures.push(f.error),
    });
    const service = new BookingService({
      provider: new TinyProvider(),
      onEvent: webhooks.listener,
    });
    await book(service);
    await webhooks.idle();
    // Filtered to booking.held only; two failures, then delivered on the third attempt.
    expect(flaky.deliveries).toHaveLength(3);
    expect(new Set(flaky.deliveries.map((d) => d.event.id)).size).toBe(1);
    expect(failures).toEqual([]);

    const gone = receiver([410]);
    const webhooks2 = createWebhooks({
      endpoints: [{ url: 'https://old.example/hooks', secret: SECRET, events: ['booking.held'] }],
      fetch: gone.fetch,
      retryDelaysMs: [0, 0, 0],
      onFailure: (f) => failures.push(`${f.endpoint} ${f.error}`),
    });
    const service2 = new BookingService({
      provider: new TinyProvider(),
      onEvent: webhooks2.listener,
    });
    await book(service2);
    await webhooks2.idle();
    expect(gone.deliveries).toHaveLength(1);
    expect(failures).toEqual(['https://old.example/hooks HTTP 410']);
  });

  it('rejects unsafe configuration up front', () => {
    expect(() => createWebhooks({ endpoints: [{ url: 'ftp://x', secret: SECRET }] })).toThrow(
      /http/,
    );
    expect(() =>
      createWebhooks({ endpoints: [{ url: 'https://x.example', secret: 'short' }] }),
    ).toThrow(/16 characters/);
  });
});
