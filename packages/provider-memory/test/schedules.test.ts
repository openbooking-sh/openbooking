import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { demoSalonConfig, MemoryBookingProvider, type ResourceSchedule } from '../src';

// Thursday 2026-10-01 08:00 Oslo time. Friday is 2026-10-02; the salon opens 09:00–18:00.
const NOW = '2026-10-01T06:00:00Z';
const FRIDAY = '2026-10-02';
const SATURDAY = '2026-10-03';

function setup(schedules: Record<string, ResourceSchedule>) {
  const config = demoSalonConfig();
  config.venues[0]!.schedules = schedules;
  const provider = new MemoryBookingProvider(config);
  return new BookingService({ provider, clock: new ManualClock(NOW) });
}

/** Who can do a haircut at `at` on `date` (stylist names). */
async function whoAt(service: BookingService, date: string, at: string, tag?: string) {
  const { slots } = await service.searchAvailability({
    date,
    party_size: { total: 1 },
    offering_id: 'haircut',
    time_from: at,
    time_to: at,
    ...(tag ? { tags: [tag] } : {}),
  });
  return slots.flatMap((s) => [s.resource?.label, ...(s.also_available ?? [])]).filter(Boolean);
}

describe('staff working hours and time off', () => {
  it('only offers a stylist inside their own working hours, and only if the service fits', async () => {
    // Maria works Fridays 12:00–18:00 only.
    const service = setup({ maria: { hours: { 5: [{ open: '12:00', close: '18:00' }] } } });

    expect(await whoAt(service, FRIDAY, '10:00', 'maria')).toEqual([]);
    expect(await whoAt(service, FRIDAY, '12:00', 'maria')).toEqual(['Maria']);
    // A 45-minute haircut at 17:30 would end after her shift.
    expect(await whoAt(service, FRIDAY, '17:30', 'maria')).toEqual([]);
    // Not listed for Saturday: a day off.
    expect(await whoAt(service, SATURDAY, '12:00', 'maria')).toEqual([]);
    // Others still work their normal (venue) hours.
    expect(await whoAt(service, FRIDAY, '10:00')).toEqual(['Jonas', 'Aisha']);
  });

  it('blocks whole days and exact times off', async () => {
    const service = setup({
      jonas: { time_off: [{ start: FRIDAY, end: FRIDAY, reason: 'Holiday' }] },
      aisha: { time_off: [{ start: `${FRIDAY}T14:00`, end: `${FRIDAY}T15:00` }] },
    });

    expect(await whoAt(service, FRIDAY, '11:00', 'jonas')).toEqual([]);
    expect(await whoAt(service, SATURDAY, '11:00', 'jonas')).toEqual(['Jonas']);
    // 13:30 + 45 min overlaps 14:00; 15:00 is free again (the end is excluded).
    expect(await whoAt(service, FRIDAY, '13:30', 'aisha')).toEqual([]);
    expect(await whoAt(service, FRIDAY, '14:30', 'aisha')).toEqual([]);
    expect(await whoAt(service, FRIDAY, '15:00', 'aisha')).toEqual(['Aisha']);
  });

  it('never holds a slot with someone who is off, even from an older slot id', async () => {
    // Search before Maria's time off is known, then hold after: the hold re-checks.
    const before = setup({});
    const { slots } = await before.searchAvailability({
      date: FRIDAY,
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '10:00',
      time_to: '10:00',
      tags: ['maria'],
    });
    const after = setup({ maria: { time_off: [{ start: FRIDAY, end: FRIDAY }] } });
    await expect(
      after.hold({ slot_id: slots[0]!.slot_id, idempotency_key: 'sched-hold-1' }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });

    // Without asking for Maria, the same time goes to whoever works.
    const open = await after.searchAvailability({
      date: FRIDAY,
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '10:00',
      time_to: '10:00',
    });
    const hold = await after.hold({
      slot_id: open.slots[0]!.slot_id,
      idempotency_key: 'sched-hold-2',
    });
    expect(hold.slot.resource?.label).not.toBe('Maria');
  });

  it('handles time off across the October DST change in venue-local time', async () => {
    // Clocks go back on Sunday 2026-10-25 in Oslo; Saturday 24th is a normal day, Tuesday 27th too.
    const service = setup({ aisha: { time_off: [{ start: '2026-10-24', end: '2026-10-27' }] } });
    expect(await whoAt(service, '2026-10-24', '10:00', 'aisha')).toEqual([]);
    expect(await whoAt(service, '2026-10-27', '17:00', 'aisha')).toEqual([]);
    expect(await whoAt(service, '2026-10-28', '09:00', 'aisha')).toEqual(['Aisha']);
  });

  it('rejects schedules for unknown people and time off that ends before it starts', () => {
    const config = demoSalonConfig();
    config.venues[0]!.schedules = { nobody: { hours: {} } };
    expect(() => new MemoryBookingProvider(config)).toThrow(/unknown resource "nobody"/);
    config.venues[0]!.schedules = { maria: { time_off: [{ start: FRIDAY, end: '2026-10-01' }] } };
    expect(() => new MemoryBookingProvider(config)).toThrow(/ends before it starts/);
    config.venues[0]!.schedules = { maria: { time_off: [{ start: 'friday', end: FRIDAY }] } };
    expect(() => new MemoryBookingProvider(config)).toThrow(/YYYY-MM-DD/);
  });
});
