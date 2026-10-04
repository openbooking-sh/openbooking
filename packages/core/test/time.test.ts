import { describe, expect, it } from 'vitest';
import { time } from '../src';

describe('time helpers', () => {
  it('converts venue-local wall time to an instant across DST', () => {
    // Oslo: CEST (+02:00) in summer, CET (+01:00) in winter.
    expect(time.zonedToInstant('2026-07-01', '19:00', 'Europe/Oslo').toISOString()).toBe(
      '2026-07-01T17:00:00.000Z',
    );
    expect(time.zonedToInstant('2026-12-01', '19:00', 'Europe/Oslo').toISOString()).toBe(
      '2026-12-01T18:00:00.000Z',
    );
  });

  it('formats with the local offset', () => {
    const t = new Date('2026-07-01T17:00:00Z');
    expect(time.formatInZone(t, 'Europe/Oslo')).toBe('2026-07-01T19:00:00+02:00');
    expect(time.formatInZone(t, 'America/New_York')).toBe('2026-07-01T13:00:00-04:00');
  });

  it('computes weekdays and date arithmetic', () => {
    expect(time.weekdayOfDate('2026-10-02')).toBe(5); // Friday
    expect(time.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(time.timeOfMinutes(time.minutesOfDay('23:30') + 60)).toBe('00:30');
  });
});
