import { describe, expect, it, vi } from 'vitest';
import { BookingService, ManualClock, type BookingError } from '@openbooking/core';
import { MemoryBookingProvider, demoSalonConfig } from '@openbooking/provider-memory';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleCalendarClient,
  attachCalendarSync,
  exchangeCode,
  googleAuthUrl,
  googleBusySource,
  type GoogleTokens,
} from '../src';
import { createFakeGoogle, memoryTokens } from './fake-google';

const CREDS = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'https://openbooking.test/oauth/google/callback',
};
const START = new Date('2026-10-05T08:00:00Z'); // Monday; the salon is open Tuesday 2026-10-06
const CUSTOMER = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const CONFIG = { defaultCalendarId: 'owner@example.com', staffCalendars: { maria: 'maria@cal' } };

const fresh = (now = START.getTime()): GoogleTokens => ({
  access_token: 'at_1',
  refresh_token: 'rt_1',
  expires_at: now + 3_600_000,
});

function setupClient(tokens: GoogleTokens | null = fresh(), clock = new ManualClock(START)) {
  const google = createFakeGoogle();
  const store = memoryTokens(tokens ?? undefined);
  const client = new GoogleCalendarClient({
    credentials: CREDS,
    tokens: store,
    fetch: google.fetch,
    now: () => clock.now().getTime(),
  });
  return { google, store, client, clock };
}

function setupSalon(opts: { cacheMs?: number; onAuthError?: (e: GoogleAuthError) => void } = {}) {
  const env = setupClient();
  const busy = googleBusySource({
    client: env.client,
    config: () => CONFIG,
    ...(opts.cacheMs !== undefined ? { cacheMs: opts.cacheMs } : {}),
    ...(opts.onAuthError ? { onAuthError: opts.onAuthError } : {}),
  });
  const provider = new MemoryBookingProvider(demoSalonConfig(), { busy });
  const service = new BookingService({ provider, clock: env.clock });
  return { ...env, service };
}

const search = (service: BookingService, who: string) =>
  service.searchAvailability({
    date: '2026-10-06',
    party_size: { total: 1 },
    offering_id: 'haircut',
    time_from: '10:00',
    time_to: '10:45',
    tags: [who],
    limit: 50,
  });

const busyEvent = (
  google: ReturnType<typeof createFakeGoogle>,
  calendarId: string,
  extra: Record<string, unknown> = {},
) =>
  google.addEvent(calendarId, {
    status: 'confirmed',
    start: { dateTime: mariaBusy.start },
    end: { dateTime: mariaBusy.end },
    ...extra,
  });

const mariaBusy = { start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' }; // 10–11 Oslo

let n = 0;
const key = () => `gcal-key-${++n}`;
const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as BookingError,
  );

describe('Google OAuth', () => {
  it('builds a consent URL for offline calendar access', () => {
    const url = new URL(googleAuthUrl(CREDS, { state: 's1', loginHint: 'owner@example.com' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('client-1');
    expect(p.get('redirect_uri')).toBe(CREDS.redirectUri);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('state')).toBe('s1');
    expect(p.get('login_hint')).toBe('owner@example.com');
    expect(p.get('scope')).toContain('https://www.googleapis.com/auth/calendar.freebusy');
    expect(p.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it('exchanges a code for tokens with the account email and expiry', async () => {
    const google = createFakeGoogle();
    const tokens = await exchangeCode(CREDS, 'good-code', {
      fetch: google.fetch,
      now: () => 1_000_000,
    });
    expect(tokens).toMatchObject({
      access_token: 'at_1',
      refresh_token: 'rt_1',
      expires_at: 1_000_000 + 3_599_000,
      email: 'owner@example.com',
    });
  });

  it('rejects a bad code as an auth error', async () => {
    const google = createFakeGoogle();
    await expect(exchangeCode(CREDS, 'bad', { fetch: google.fetch })).rejects.toBeInstanceOf(
      GoogleAuthError,
    );
  });
});

describe('GoogleCalendarClient', () => {
  it('refreshes an expired access token, persists it and keeps the refresh token', async () => {
    const { google, store, client } = setupClient({ ...fresh(), expires_at: START.getTime() });
    const calendars = await client.listCalendars();
    expect(calendars.map((c) => c.id)).toEqual(['owner@example.com', 'maria@cal']);
    expect(calendars[0]!.primary).toBe(true);
    expect(google.refreshes).toBe(1);
    expect(store.current).toMatchObject({
      access_token: 'at_2',
      refresh_token: 'rt_1',
      expires_at: START.getTime() + 3_599_000,
    });
  });

  it('shares one refresh between concurrent calls', async () => {
    const { google, client } = setupClient({ ...fresh(), expires_at: 0 });
    await Promise.all([client.listCalendars(), client.listCalendars(), client.listCalendars()]);
    expect(google.refreshes).toBe(1);
  });

  it('refreshes once and retries on a 401', async () => {
    const { google, client } = setupClient();
    google.reject401Once = true;
    await client.listCalendars();
    expect(google.refreshes).toBe(1);
  });

  it('reports a revoked refresh token as GoogleAuthError', async () => {
    const { google, client } = setupClient({ ...fresh(), expires_at: 0 });
    google.revoked = true;
    await expect(client.listCalendars()).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('reports a missing connection as GoogleAuthError', async () => {
    const { client } = setupClient(null);
    await expect(client.listCalendars()).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('maps freeBusy answers per calendar and fails on calendar errors', async () => {
    const { google, client } = setupClient();
    google.busy['maria@cal'] = [mariaBusy];
    const busy = await client.freeBusy(
      ['maria@cal', 'owner@example.com'],
      new Date('2026-10-06T00:00:00Z'),
      new Date('2026-10-07T00:00:00Z'),
    );
    expect(busy.get('maria@cal')).toEqual([
      { start: new Date(mariaBusy.start), end: new Date(mariaBusy.end) },
    ]);
    expect(busy.get('owner@example.com')).toEqual([]);
    await expect(
      client.freeBusy(['missing@cal'], new Date(), new Date(Date.now() + 1000)),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });

  it('treats deleting an already deleted event as done', async () => {
    const { client } = setupClient();
    await expect(client.deleteEvent('primary', 'gone')).resolves.toBeUndefined();
  });
});

describe('googleBusySource', () => {
  it('blocks only the staff member whose calendar is busy', async () => {
    const { google, service } = setupSalon();
    busyEvent(google, 'maria@cal');
    expect((await search(service, 'maria')).slots).toEqual([]);
    const jonas = await search(service, 'jonas');
    expect(jonas.slots.map((s) => s.start)).toEqual([
      '2026-10-06T10:00:00+02:00',
      '2026-10-06T10:15:00+02:00',
      '2026-10-06T10:30:00+02:00',
      '2026-10-06T10:45:00+02:00',
    ]);
    expect(jonas.slots.every((s) => s.resource?.id === 'jonas')).toBe(true);
  });

  it('busy in the default calendar blocks staff without their own calendar', async () => {
    const { google, service } = setupSalon();
    busyEvent(google, 'owner@example.com');
    expect((await search(service, 'jonas')).slots).toEqual([]);
    expect((await search(service, 'maria')).slots).toHaveLength(4);
  });

  it('refuses a hold when the only fitting staff member became busy', async () => {
    const { google, service } = setupSalon({ cacheMs: 0 });
    const [slot] = (await search(service, 'maria')).slots;
    expect(slot?.resource?.id).toBe('maria');
    busyEvent(google, 'maria@cal');
    const err = await fail(service.hold({ slot_id: slot!.slot_id, idempotency_key: key() }));
    expect(err?.code).toBe('slot_unavailable');
  });

  it('caches busy-time answers briefly per range', async () => {
    const { google, service, clock } = setupSalon();
    await search(service, 'maria');
    await search(service, 'jonas');
    expect(google.listCalls).toBe(2); // one events.list per calendar
    clock.advanceSeconds(31);
    await search(service, 'maria');
    expect(google.listCalls).toBe(4);
  });

  it('fails open when the Google connection is gone', async () => {
    const onAuthError = vi.fn();
    const { google, service, store } = setupSalon({ onAuthError });
    await store.set({ ...fresh(), expires_at: 0 });
    google.revoked = true;
    busyEvent(google, 'maria@cal');
    expect((await search(service, 'maria')).slots).toHaveLength(4);
    expect(onAuthError).toHaveBeenCalledWith(expect.any(GoogleAuthError));
  });

  it('fails closed when Google has a transient error', async () => {
    const { google, service } = setupSalon();
    google.eventsStatus = 500;
    const err = await fail(search(service, 'maria'));
    expect(err?.code).toBe('provider_error');
    expect(err?.retryable).toBe(true);
  });
  it("ignores OpenBooking's own events on a calendar shared by several staff", async () => {
    const { google, service } = setupSalon();
    busyEvent(google, 'owner@example.com', {
      extendedProperties: { private: { openbooking_booking_id: 'bk_other' } },
    });
    expect((await search(service, 'jonas')).slots).toHaveLength(4);
  });

  it('ignores free, cancelled and declined events', async () => {
    const { google, service } = setupSalon();
    busyEvent(google, 'owner@example.com', { transparency: 'transparent' });
    busyEvent(google, 'owner@example.com', { status: 'cancelled' });
    busyEvent(google, 'owner@example.com', {
      attendees: [
        { email: 'someone@example.com', responseStatus: 'accepted' },
        { email: 'owner@example.com', self: true, responseStatus: 'declined' },
      ],
    });
    expect((await search(service, 'jonas')).slots).toHaveLength(4);
  });

  it('blocks the whole local day for an all-day event', async () => {
    const { google, service } = setupSalon();
    google.addEvent('owner@example.com', {
      status: 'confirmed',
      start: { date: '2026-10-06' },
      end: { date: '2026-10-07' },
    });
    const day = await service.searchAvailability({
      date: '2026-10-06',
      party_size: { total: 1 },
      offering_id: 'haircut',
      tags: ['jonas'],
      limit: 50,
    });
    expect(day.slots).toEqual([]);
    // The next day (in Oslo) is unaffected.
    const next = await service.searchAvailability({
      date: '2026-10-07',
      party_size: { total: 1 },
      offering_id: 'haircut',
      time_from: '09:00',
      time_to: '09:00',
      tags: ['jonas'],
    });
    expect(next.slots).toHaveLength(1);
  });

  it('follows events.list pages', async () => {
    const { google, client } = setupClient();
    google.pageSize = 2;
    for (const h of [8, 9, 10, 11, 12]) {
      google.addEvent('maria@cal', {
        start: { dateTime: `2026-10-06T${String(h).padStart(2, '0')}:00:00Z` },
        end: { dateTime: `2026-10-06T${String(h).padStart(2, '0')}:30:00Z` },
      });
    }
    const busy = await client.listBusyEvents(
      'maria@cal',
      new Date('2026-10-06T00:00:00Z'),
      new Date('2026-10-07T00:00:00Z'),
    );
    expect(busy.map((b) => b.start.toISOString())).toEqual([
      '2026-10-06T08:00:00.000Z',
      '2026-10-06T09:00:00.000Z',
      '2026-10-06T10:00:00.000Z',
      '2026-10-06T11:00:00.000Z',
      '2026-10-06T12:00:00.000Z',
    ]);
    expect(google.listCalls).toBe(3);
  });
});

describe('attachCalendarSync', () => {
  function setupSync() {
    const env = setupClient();
    const provider = new MemoryBookingProvider(demoSalonConfig());
    const service = new BookingService({ provider, clock: env.clock });
    const onError = vi.fn();
    const sync = attachCalendarSync({
      service,
      client: env.client,
      config: () => CONFIG,
      onError,
    });
    return { ...env, service, sync, onError };
  }

  async function book(service: BookingService) {
    const [slot] = (await search(service, 'maria')).slots;
    const hold = await service.hold({
      slot_id: slot!.slot_id,
      idempotency_key: key(),
      customer: { ...CUSTOMER, phone_number: '+4712345678' },
      notes: 'Short on the sides',
    });
    return service.confirm({
      booking_id: hold.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
  }

  it("adds a confirmed booking to the staff member's calendar and removes it on cancel", async () => {
    const { google, service, sync, onError } = setupSync();
    const booking = await book(service);
    await sync.idle();

    const events = google.events.get('maria@cal') ?? [];
    expect(events).toHaveLength(1);
    const body = events[0]!.body;
    expect(body.summary).toBe('Haircut – Ada Lovelace');
    expect(body.start).toEqual({ dateTime: booking.slot.start, timeZone: 'Europe/Oslo' });
    expect(body.end).toEqual({ dateTime: booking.slot.end, timeZone: 'Europe/Oslo' });
    expect(body.extendedProperties.private).toEqual({
      openbooking_booking_id: booking.booking_id,
    });
    expect(body.description).toContain('Phone: +4712345678');
    expect(body.description).toContain('Notes: Short on the sides');
    expect(body.description).toContain('Booked via OpenBooking');
    expect(body.description).toContain(`Confirmation code: ${booking.confirmation_code}`);

    await service.cancel({
      booking_id: booking.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    await sync.idle();
    expect(google.events.get('maria@cal')).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('inserts once when the same booking is confirmed again', async () => {
    const { google, service, sync } = setupSync();
    const booking = await book(service);
    await service.confirm({
      booking_id: booking.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
    await sync.idle();
    expect(google.events.get('maria@cal')).toHaveLength(1);
  });

  it('ignores released holds and reports failures without affecting bookings', async () => {
    const { google, service, sync, onError } = setupSync();
    const [slot] = (await search(service, 'maria')).slots;
    const hold = await service.hold({ slot_id: slot!.slot_id, idempotency_key: key() });
    await service.cancel({ booking_id: hold.booking_id, idempotency_key: key() });
    await sync.idle();
    expect(google.events.size).toBe(0);

    google.revoked = true;
    google.accessToken = 'rotated-elsewhere';
    const booking = await book(service);
    expect(booking.status).toBe('confirmed');
    await sync.idle();
    expect(onError).toHaveBeenCalledWith(expect.any(GoogleAuthError));
  });
});
