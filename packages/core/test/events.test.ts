import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, runAsActor, type BookingEvent } from '../src';
import { TinyProvider } from './fixtures';

describe('events, actors and listing', () => {
  it('stamps the current actor on events and supports multiple listeners', async () => {
    const service = new BookingService({
      provider: new TinyProvider(),
      clock: new ManualClock('2026-10-01T12:00:00Z'),
    });
    const a: BookingEvent[] = [];
    const b: BookingEvent[] = [];
    service.on((e) => a.push(e));
    const off = service.on((e) => b.push(e));

    await runAsActor({ protocol: 'mcp', agent: 'Claude', client: 'claude-ai' }, () =>
      service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' }),
    );
    off();
    await service.getBooking('missing').catch(() => {});

    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ operation: 'hold', ok: true, actor: { agent: 'Claude' } });
    expect(a[1]).toMatchObject({ operation: 'get', ok: false, booking_id: 'missing' });
    expect(a[1]!.actor).toBeUndefined();
    expect(b).toHaveLength(1);
  });

  it('a throwing listener never breaks a booking', async () => {
    const service = new BookingService({ provider: new TinyProvider() });
    service.on(() => {
      throw new Error('boom');
    });
    await expect(
      service.hold({ slot_id: 'slot-1', idempotency_key: 'hold-key-1' }),
    ).resolves.toMatchObject({ status: 'held' });
  });

  it('listBookings reports operation_not_supported when the provider cannot list', async () => {
    const service = new BookingService({ provider: new TinyProvider() });
    await expect(service.listBookings()).rejects.toMatchObject({ code: 'operation_not_supported' });
  });
});
