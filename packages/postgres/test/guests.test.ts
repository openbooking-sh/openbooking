import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { describeGuestStore } from '../../core/test/guest-store-contract';
import { PostgresBookingStore, PostgresGuestStore } from '../src';
import { freshDb, target } from './helpers';

describeGuestStore(`postgres (${target})`, async () => new PostgresGuestStore(await freshDb()));

describe(`PostgresGuestStore (${target})`, () => {
  it('is shared by every instance, and holds no contact detail', async () => {
    const db = await freshDb();
    await new PostgresGuestStore(db).saveProfile('salon', 'a'.repeat(64), {
      tags: ['regular'],
      notes: 'prefers Kari',
      vip: true,
      updated_at: '2026-10-01T08:00:00.000Z',
    });
    // Another server instance (a fresh object on the same database) sees it at once.
    const seen = await new PostgresGuestStore(db).listProfiles('salon');
    expect(seen.get('a'.repeat(64))).toMatchObject({ tags: ['regular'], vip: true });
    const { rows } = await db.query('select * from ob_guest_profiles');
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ['guest_key', 'notes', 'tags', 'updated_at', 'venue_id', 'vip'].sort(),
    );
  });

  it('keeps a dietary note out of the booking row and gone after the retention period', async () => {
    const db = await freshDb();
    const guests = new PostgresGuestStore(db);
    const service = new BookingService({
      provider: createDemoSalonProvider({ store: new PostgresBookingStore(db) }),
      clock: new ManualClock('2026-10-01T06:00:00Z'),
      guests,
    });
    const venue = (await service.listVenues())[0]!;
    const { slots } = await service.searchAvailability({
      date: '2026-10-02',
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '15:00',
      time_to: '15:00',
    });
    const held = await service.hold({
      slot_id: slots[0]!.slot_id,
      idempotency_key: 'hold-key-pg-1',
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      dietary_notes: 'ZXQ-sentinel-pg-allergy',
    });
    const { rows } = await db.query('select data::text as data from ob_bookings');
    expect(JSON.stringify(rows)).not.toContain('ZXQ-sentinel-pg-allergy');
    expect((await guests.dietaryNotes(venue.id, [held.booking_id])).size).toBe(1);
    // The visit is in the future, so nothing is due; once it is long past, it is deleted.
    expect(await guests.purgeDietaryNotes(new Date('2026-10-01T06:00:00Z'))).toBe(0);
    expect(await guests.purgeDietaryNotes(new Date('2026-10-03T06:00:00Z'))).toBe(1);
  });
});
