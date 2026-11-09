import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { MemoryBookingProvider, MemoryBookingStore, type VenueConfig } from '../src';
import { combinationVenue, describeTableCombinations, DAY } from './combination-suite';

describeTableCombinations('memory store', () => new MemoryBookingStore(), 30);

const make = (cfg: VenueConfig) => new MemoryBookingProvider({ name: 'T', venues: [cfg] });

describe('table combinations: config', () => {
  const withCombos = (table_combinations: VenueConfig['table_combinations']): VenueConfig => ({
    ...combinationVenue(),
    table_combinations,
  });

  it('refuses a combination that names a table that does not exist', () => {
    expect(() =>
      make(withCombos([{ resource_ids: ['f1', 'nope'], min_party_size: 5, max_party_size: 8 }])),
    ).toThrow(/unknown resource "nope"/);
  });

  it('refuses a single table, the same table twice and mixed kinds', () => {
    expect(() =>
      make(withCombos([{ resource_ids: ['f1'], min_party_size: 5, max_party_size: 8 }])),
    ).toThrow(/two or more different tables/);
    expect(() =>
      make(withCombos([{ resource_ids: ['f1', 'f1'], min_party_size: 5, max_party_size: 8 }])),
    ).toThrow(/two or more different tables/);
    const cfg = combinationVenue();
    cfg.resources[1] = { ...cfg.resources[1]!, kind: 'room' };
    expect(() => make(cfg)).toThrow(/mixes kinds/);
  });

  it('refuses party ranges that make no sense, or that the tables cannot seat', () => {
    expect(() =>
      make(withCombos([{ resource_ids: ['f1', 'f2'], min_party_size: 8, max_party_size: 5 }])),
    ).toThrow(/max_party_size >= min_party_size/);
    expect(() =>
      make(withCombos([{ resource_ids: ['f1', 'f2'], min_party_size: 0, max_party_size: 5 }])),
    ).toThrow(/min_party_size >= 1/);
    expect(() =>
      make(withCombos([{ resource_ids: ['p1', 'p2'], min_party_size: 5, max_party_size: 9 }])),
    ).toThrow(/hold fewer/);
    expect(() =>
      make(
        withCombos([
          {
            resource_ids: ['f1', 'f2'],
            min_party_size: 5,
            max_party_size: 8,
            extra_buffer_minutes: -5,
          },
        ]),
      ),
    ).toThrow(/extra_buffer_minutes/);
  });

  it('refuses the same tables listed twice for overlapping party sizes, allows adjacent ranges', () => {
    expect(() =>
      make(
        withCombos([
          { resource_ids: ['f1', 'f2'], min_party_size: 5, max_party_size: 6 },
          { resource_ids: ['f2', 'f1'], min_party_size: 6, max_party_size: 8 },
        ]),
      ),
    ).toThrow(/twice with overlapping party sizes/);
    expect(() =>
      make(
        withCombos([
          { resource_ids: ['f1', 'f2'], min_party_size: 5, max_party_size: 6 },
          {
            resource_ids: ['f2', 'f1'],
            min_party_size: 7,
            max_party_size: 8,
            label: 'The long table',
          },
        ]),
      ),
    ).not.toThrow();
  });

  it('refuses tables of a kind no offering uses', () => {
    const cfg = combinationVenue();
    cfg.offerings = cfg.offerings.map((o) => ({ ...o, resource_kinds: ['staff'] }));
    expect(() => make(cfg)).toThrow(/no offering uses resources of kind "table"/);
  });

  it('uses the label from the config when there is one', async () => {
    const cfg = withCombos([
      { resource_ids: ['f1', 'f2'], min_party_size: 5, max_party_size: 8, label: 'The long table' },
    ]);
    const service = new BookingService({
      provider: make(cfg),
      clock: new ManualClock('2026-10-12T08:00:00Z'),
    });
    const { slots } = await service.searchAvailability({
      date: DAY,
      party_size: { total: 7 },
      time_from: '19:00',
      time_to: '19:00',
    });
    expect(slots[0]!.resource!.label).toBe('The long table');
  });
});

describe('table combinations: old configs', () => {
  it('behaves as before without table_combinations: one table, larger parties refused', async () => {
    const cfg = combinationVenue();
    delete cfg.table_combinations;
    const service = new BookingService({
      provider: make(cfg),
      clock: new ManualClock('2026-10-12T08:00:00Z'),
    });
    await expect(
      service.searchAvailability({ date: DAY, party_size: { total: 5 } }),
    ).rejects.toMatchObject({ code: 'party_size_unsupported' });
    const { slots } = await service.searchAvailability({
      date: DAY,
      party_size: { total: 4 },
      time_from: '19:00',
      time_to: '19:00',
    });
    expect(slots[0]!.resource).toMatchObject({ id: 'f1', label: 'Table for up to 4' });
    expect(slots[0]).not.toHaveProperty('additional_resources');
  });

  it('says the largest joined party in the refusal limit', async () => {
    const service = new BookingService({
      provider: make(combinationVenue()),
      clock: new ManualClock('2026-10-12T08:00:00Z'),
    });
    await expect(
      service.searchAvailability({ date: DAY, party_size: { total: 9 } }),
    ).rejects.toMatchObject({ code: 'party_size_unsupported' });
    const ok = await service.searchAvailability({ date: DAY, party_size: { total: 8 } });
    expect(ok.slots.length).toBeGreaterThan(0);
  });
});
