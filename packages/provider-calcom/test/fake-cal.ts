/**
 * A fake Cal.com API v2, modelled on the documented request/response shapes. It enforces the
 * Authorization header and the per-endpoint cal-api-version so tests fail if the client drifts.
 */
const VERSIONS: Array<[RegExp, string]> = [
  [/^\/v2\/slots/, '2024-09-04'],
  [/^\/v2\/bookings/, '2026-02-25'],
  [/^\/v2\/event-types/, '2026-06-12'],
];

export interface FakeBooking {
  uid: string;
  status: string;
  start: string;
  end: string;
  eventTypeId: number;
  attendee: { name: string; email: string; timeZone: string; phoneNumber?: string };
  metadata?: Record<string, string>;
  cancellationReason?: string;
}

export function createFakeCal(apiKey = 'test-key') {
  const eventTypes = [
    {
      id: 11,
      title: 'Haircut',
      slug: 'haircut',
      lengthInMinutes: 45,
      price: 65000,
      currency: 'nok',
      hidden: false,
    },
    {
      id: 12,
      title: 'Beard trim',
      slug: 'beard',
      lengthInMinutes: 30,
      price: 0,
      currency: 'nok',
      hidden: false,
    },
    { id: 13, title: 'Internal', slug: 'internal', lengthInMinutes: 15, hidden: true },
  ];
  // Free slot starts (UTC) per event type. Oslo is UTC+2 in October.
  const baseSlots = [
    '2026-10-01T22:30:00Z', // 00:30 on Oct 2 locally (must count as Oct 2)
    '2026-10-02T07:00:00Z', // 09:00
    '2026-10-02T08:00:00Z', // 10:00
    '2026-10-02T13:00:00Z', // 15:00
    '2026-10-02T22:30:00Z', // 00:30 on Oct 3 locally (must be excluded for Oct 2)
  ];
  const reservations = new Map<
    string,
    { eventTypeId: number; slotStart: string; reservationDuration: number }
  >();
  const bookings = new Map<string, FakeBooking>();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let seq = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (status: number, message: string) =>
    json(status, { status: 'error', error: { message } });
  const same = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();
  const busy = (eventTypeId: number, start: string) =>
    [...reservations.values()].some(
      (r) => r.eventTypeId === eventTypeId && same(r.slotStart, start),
    ) ||
    [...bookings.values()].some(
      (b) => b.eventTypeId === eventTypeId && same(b.start, start) && b.status !== 'cancelled',
    );

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (headers.get('authorization') !== `Bearer ${apiKey}`) return err(401, 'Invalid API key');
    const version = VERSIONS.find(([re]) => re.test(url.pathname))?.[1];
    if (headers.get('cal-api-version') !== version) {
      return err(
        400,
        `wrong cal-api-version ${headers.get('cal-api-version')} for ${url.pathname}`,
      );
    }
    const p = url.pathname;

    if (method === 'GET' && p === '/v2/event-types')
      return json(200, { status: 'success', data: eventTypes });

    if (method === 'GET' && p === '/v2/slots') {
      const eventTypeId = Number(url.searchParams.get('eventTypeId'));
      const type = eventTypes.find((t) => t.id === eventTypeId);
      if (!type) return err(404, 'event type not found');
      if (url.searchParams.get('format') !== 'range') return err(400, 'test expects format=range');
      const data: Record<string, Array<{ start: string; end: string }>> = {};
      for (const s of baseSlots.filter((s) => !busy(eventTypeId, s))) {
        const end = new Date(new Date(s).getTime() + type.lengthInMinutes * 60_000).toISOString();
        (data[s.slice(0, 10)] ??= []).push({ start: s, end });
      }
      return json(200, { status: 'success', data });
    }

    if (method === 'POST' && p === '/v2/slots/reservations') {
      if (busy(body.eventTypeId, body.slotStart)) return err(400, 'Slot is not available');
      const uid = `res-${++seq}`;
      reservations.set(uid, body);
      return json(201, {
        status: 'success',
        data: {
          eventTypeId: body.eventTypeId,
          slotStart: body.slotStart,
          reservationUid: uid,
          reservationDuration: body.reservationDuration ?? 5,
          reservationUntil: new Date(
            Date.now() + (body.reservationDuration ?? 5) * 60_000,
          ).toISOString(),
        },
      });
    }

    const delRes = p.match(/^\/v2\/slots\/reservations\/(.+)$/);
    if (method === 'DELETE' && delRes) {
      reservations.delete(decodeURIComponent(delRes[1]!));
      return json(200, { status: 'success' });
    }

    if (method === 'POST' && p === '/v2/bookings') {
      if (!body.attendee?.email) return err(400, 'attendee.email is required');
      // Our own reservation for this slot does not block the booking.
      const others = [...bookings.values()].some(
        (b) =>
          b.eventTypeId === body.eventTypeId &&
          same(b.start, body.start) &&
          b.status !== 'cancelled',
      );
      if (others)
        return err(400, 'User either already has booking at this time or is not available');
      const type = eventTypes.find((t) => t.id === body.eventTypeId)!;
      const uid = `calbk${++seq}abcdef`;
      const booking: FakeBooking = {
        uid,
        status: 'accepted',
        start: body.start,
        end: new Date(new Date(body.start).getTime() + type.lengthInMinutes * 60_000).toISOString(),
        eventTypeId: body.eventTypeId,
        attendee: body.attendee,
        metadata: body.metadata,
      };
      bookings.set(uid, booking);
      return json(201, { status: 'success', data: booking });
    }

    const one = p.match(/^\/v2\/bookings\/([^/]+)$/);
    if (method === 'GET' && one) {
      const b = bookings.get(decodeURIComponent(one[1]!));
      return b ? json(200, { status: 'success', data: b }) : err(404, 'not found');
    }

    const cancel = p.match(/^\/v2\/bookings\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancel) {
      const b = bookings.get(decodeURIComponent(cancel[1]!));
      if (!b) return err(404, 'not found');
      b.status = 'cancelled';
      b.cancellationReason = body?.cancellationReason;
      return json(200, { status: 'success', data: b });
    }

    return err(404, `no route ${method} ${p}`);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    reservations,
    bookings,
    calls,
    /** Someone else books a slot directly in Cal.com. */
    externalBooking(eventTypeId: number, start: string) {
      bookings.set(`ext${++seq}`, {
        uid: `ext${seq}`,
        status: 'accepted',
        start,
        end: start,
        eventTypeId,
        attendee: { name: 'Walk In', email: 'x@example.com', timeZone: 'UTC' },
      });
    },
  };
}
