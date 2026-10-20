import { describe, expect, it } from 'vitest';
import { toActivityEntry } from '../src';

describe('activity for expiry events', () => {
  it('credits the system, not "Direct API", and keeps no customer details', () => {
    const entry = toActivityEntry({
      operation: 'expire',
      ok: true,
      at: '2026-10-01T12:10:00.000Z',
      booking_id: 'b1',
      status: 'expired',
    });
    expect(entry).toEqual({
      at: '2026-10-01T12:10:00.000Z',
      operation: 'expire',
      ok: true,
      booking_id: 'b1',
      status: 'expired',
      agent: 'System',
      protocol: 'system',
    });
  });
});
