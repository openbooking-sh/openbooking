import { describe, expect, it } from 'vitest';
import { createClient, OpenBookingError } from '../src';

type Call = { url: string; init: RequestInit };

/** A client whose `fetch` records requests and answers from a queue. */
function setup(...answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const client = createClient({
    baseUrl: 'https://app.example.com/b/studio-nord/book/',
    headers: { 'x-test': '1' },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = answers.shift() ?? json({});
      if (next instanceof Error) throw next;
      return next;
    },
  });
  const body = (i = 0) => JSON.parse(String(calls[i]!.init.body));
  return { client, calls, body };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const apiError = (code: string, status: number, extra: object = {}) =>
  json(
    {
      error: {
        code,
        message: `message for ${code}`,
        suggested_next_action: `do this for ${code}`,
        retryable: false,
        ...extra,
      },
    },
    status,
  );

describe('requests', () => {
  it('calls <baseUrl>/api/..., with or without a trailing slash, and sends the extra headers', async () => {
    const t = setup(json({}));
    await t.client.info();
    expect(t.calls[0]!.url).toBe('https://app.example.com/b/studio-nord/book/api/info');
    expect(t.calls[0]!.init.method).toBe('GET');
    expect(t.calls[0]!.init.headers).toMatchObject({ accept: 'application/json', 'x-test': '1' });
    expect(t.calls[0]!.init.body).toBeUndefined();
  });

  it('sends only the availability filters that are set', async () => {
    const t = setup(json({ date: '2026-10-16', slots: [] }));
    await t.client.availability({ date: '2026-10-16', staff: 'maria', party: 2 });
    const url = new URL(t.calls[0]!.url);
    expect(url.pathname).toBe('/b/studio-nord/book/api/availability');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      date: '2026-10-16',
      staff: 'maria',
      party: '2',
    });
  });

  it('encodes ids and codes in the path and query', async () => {
    const t = setup(json({ booking: {} }), json({ booking: {} }), json({ booking: {} }));
    await t.client.getHold('a/b c');
    await t.client.getBooking('a/b c', 'X Y&Z');
    await t.client.cancel('a/b c', { code: 'ABC', user_confirmed: true });
    expect(t.calls[0]!.url).toContain('/holds/a%2Fb%20c');
    expect(t.calls[1]!.url).toContain('/bookings/a%2Fb%20c?code=X%20Y%26Z');
    expect(t.calls[2]!.url).toContain('/bookings/a%2Fb%20c/cancel');
  });

  it('unwraps the booking and the released flag', async () => {
    const t = setup(
      json({ booking: { booking_id: 'b1' } }),
      json({ released: true }),
      json({ released: false }),
    );
    expect((await t.client.hold({ slot_id: 's' })).booking_id).toBe('b1');
    expect(await t.client.releaseHold('b1')).toBe(true);
    expect(await t.client.releaseHold('b1')).toBe(false);
    expect(t.calls[1]!.init.body).toBeUndefined();
  });
});

describe('idempotency keys', () => {
  it('uses the key the caller gives, on every write', async () => {
    const t = setup(json({ booking: {} }), json({ booking: {} }), json({ booking: {} }));
    await t.client.hold({ slot_id: 's', idempotency_key: 'my-hold-key-1' });
    await t.client.confirm({
      booking_id: 'b',
      user_confirmed: true,
      customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
      idempotency_key: 'my-confirm-key-1',
    });
    await t.client.cancel('b', { code: 'C', user_confirmed: true, idempotency_key: 'my-cancel-1' });
    expect(t.body(0).idempotency_key).toBe('my-hold-key-1');
    expect(t.body(1).idempotency_key).toBe('my-confirm-key-1');
    expect(t.body(2).idempotency_key).toBe('my-cancel-1');
  });

  it('makes a new key for each call when none is given, valid for the API (8 to 128 characters)', async () => {
    const t = setup(json({ booking: {} }), json({ booking: {} }));
    await t.client.hold({ slot_id: 's' });
    await t.client.hold({ slot_id: 's' });
    const [a, b] = [t.body(0).idempotency_key, t.body(1).idempotency_key];
    expect(a).not.toBe(b);
    for (const k of [a, b]) expect(k).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends the consent flag and the customer as given', async () => {
    const t = setup(json({ booking: {} }));
    await t.client.confirm({
      booking_id: 'b',
      user_confirmed: true,
      customer: { first_name: 'Ada', last_name: 'Lovelace', phone_number: '+4712345678' },
      notes: 'Short on the sides',
      payment_token: 'cs_test_1',
    });
    expect(t.body()).toMatchObject({
      booking_id: 'b',
      user_confirmed: true,
      customer: { first_name: 'Ada', last_name: 'Lovelace', phone_number: '+4712345678' },
      notes: 'Short on the sides',
      payment_token: 'cs_test_1',
    });
  });
});

describe('errors', () => {
  it('turns an API error into an OpenBookingError with what to do next', async () => {
    const t = setup(
      apiError('slot_unavailable', 409, { retryable: true, details: { slot_id: 's' } }),
    );
    const err = await t.client.hold({ slot_id: 's' }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenBookingError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: 'OpenBookingError',
      code: 'slot_unavailable',
      message: 'message for slot_unavailable',
      status: 409,
      suggestedNextAction: 'do this for slot_unavailable',
      retryable: true,
      details: { slot_id: 's' },
    });
  });

  it('reports no answer as network_error, retryable, with the cause', async () => {
    const cause = new TypeError('fetch failed');
    const t = setup(cause);
    const err = (await t.client.info().catch((e) => e)) as OpenBookingError;
    expect(err.code).toBe('network_error');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
    expect(err.cause).toBe(cause);
    expect(err.suggestedNextAction).toContain('same idempotency_key');
  });

  it('lets an abort through as it is, since the caller asked for it', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const t = setup(abort);
    expect(await t.client.info().catch((e) => e)).toBe(abort);
  });

  it('passes the abort signal on to fetch', async () => {
    const t = setup(json({}));
    const controller = new AbortController();
    await t.client.info({ signal: controller.signal });
    expect(t.calls[0]!.init.signal).toBe(controller.signal);
  });

  it('calls an answer that is not our API invalid_response, retryable only for 5xx', async () => {
    const t = setup(
      new Response('<html>Bad gateway</html>', { status: 502 }),
      json({ unexpected: true }, 404),
      json({ error: { code: 123 } }, 400),
    );
    const first = (await t.client.info().catch((e) => e)) as OpenBookingError;
    expect(first).toMatchObject({ code: 'invalid_response', status: 502, retryable: true });
    const second = (await t.client.info().catch((e) => e)) as OpenBookingError;
    expect(second).toMatchObject({ code: 'invalid_response', status: 404, retryable: false });
    const third = (await t.client.info().catch((e) => e)) as OpenBookingError;
    expect(third).toMatchObject({ code: 'invalid_response', status: 400 });
  });
});
