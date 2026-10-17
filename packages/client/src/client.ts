import { OpenBookingError } from './errors';
import type {
  Availability,
  AvailabilityParams,
  BookingDetail,
  CancelInput,
  ConfirmInput,
  ConfirmedBooking,
  ConfirmedHold,
  Booking,
  HoldInput,
  Info,
} from './types';

export interface ClientOptions {
  /**
   * The booking API of one business: the booking page address plus `/book`, for example
   * `https://app.openbooking.sh/b/studio-nord/book`. Its OpenAPI document is at `<baseUrl>/api/openapi.json`.
   */
  baseUrl: string;
  /** Defaults to the global `fetch`. Pass your own for tests, retries or a proxy. */
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface CallOptions {
  /** Abort the request. */
  signal?: AbortSignal;
}

export interface OpenBookingClient {
  /** The business, its services and its staff. */
  info(options?: CallOptions): Promise<Info>;
  /** Free times on one day. */
  availability(params: AvailabilityParams, options?: CallOptions): Promise<Availability>;
  /** Reserve a time for a few minutes. Books nothing yet. */
  hold(input: HoldInput, options?: CallOptions): Promise<Booking>;
  /** Read a hold, as the confirm page does. */
  getHold(bookingId: string, options?: CallOptions): Promise<BookingDetail | ConfirmedHold>;
  /** Let go of a hold that is no longer wanted. Resolves to whether it was still a hold. */
  releaseHold(bookingId: string, options?: CallOptions): Promise<boolean>;
  /** Confirm a held booking, after the customer said yes to the time, price and terms. */
  confirm(input: ConfirmInput, options?: CallOptions): Promise<ConfirmedBooking>;
  /** Read a booking with its confirmation code. */
  getBooking(bookingId: string, code: string, options?: CallOptions): Promise<BookingDetail>;
  /** Cancel a confirmed booking, after the customer said yes to the cancellation terms. */
  cancel(bookingId: string, input: CancelInput, options?: CallOptions): Promise<BookingDetail>;
}

export function createClient(options: ClientOptions): OpenBookingClient {
  const base = `${options.baseUrl.replace(/\/+$/, '')}/api`;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(call?.signal ? { signal: call.signal } : {}),
      });
    } catch (e) {
      // An abort is the caller's own doing: let it through as it is.
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new OpenBookingError('network_error', 'Could not reach the booking service.', {
        retryable: true,
        suggestedNextAction:
          'Check the connection and retry the same call with the same idempotency_key.',
        cause: e,
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new OpenBookingError('invalid_response', `Answer was not JSON (HTTP ${res.status}).`, {
        status: res.status,
        retryable: res.status >= 500,
        cause: e,
      });
    }

    if (!res.ok) {
      const error = (json as { error?: Record<string, unknown> } | null)?.error;
      if (error && typeof error.code === 'string' && typeof error.message === 'string') {
        throw new OpenBookingError(error.code as OpenBookingError['code'], error.message, {
          status: res.status,
          ...(typeof error.suggested_next_action === 'string'
            ? { suggestedNextAction: error.suggested_next_action }
            : {}),
          retryable: error.retryable === true,
          ...(error.details && typeof error.details === 'object'
            ? { details: error.details as Record<string, unknown> }
            : {}),
        });
      }
      throw new OpenBookingError('invalid_response', `Unexpected answer (HTTP ${res.status}).`, {
        status: res.status,
        retryable: res.status >= 500,
      });
    }
    return json as T;
  }

  const get = <T>(path: string, call?: CallOptions) => request<T>('GET', path, undefined, call);
  const post = <T>(path: string, body: unknown, call?: CallOptions) =>
    request<T>('POST', path, body, call);
  const id = encodeURIComponent;
  const key = (given: string | undefined) => given ?? crypto.randomUUID();

  return {
    info: (call) => get<Info>('/info', call),

    availability(params, call) {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
      return get<Availability>(`/availability?${query}`, call);
    },

    async hold(input, call) {
      const { booking } = await post<{ booking: Booking }>(
        '/hold',
        { slot_id: input.slot_id, idempotency_key: key(input.idempotency_key) },
        call,
      );
      return booking;
    },

    async getHold(bookingId, call) {
      const { booking } = await get<{ booking: BookingDetail | ConfirmedHold }>(
        `/holds/${id(bookingId)}`,
        call,
      );
      return booking;
    },

    async releaseHold(bookingId, call) {
      const { released } = await post<{ released: boolean }>(
        `/holds/${id(bookingId)}/release`,
        undefined,
        call,
      );
      return released;
    },

    async confirm(input, call) {
      const { idempotency_key, ...rest } = input;
      const { booking } = await post<{ booking: ConfirmedBooking }>(
        '/confirm',
        { ...rest, idempotency_key: key(idempotency_key) },
        call,
      );
      return booking;
    },

    async getBooking(bookingId, code, call) {
      const { booking } = await get<{ booking: BookingDetail }>(
        `/bookings/${id(bookingId)}?code=${encodeURIComponent(code)}`,
        call,
      );
      return booking;
    },

    async cancel(bookingId, input, call) {
      const { idempotency_key, ...rest } = input;
      const { booking } = await post<{ booking: BookingDetail }>(
        `/bookings/${id(bookingId)}/cancel`,
        { ...rest, idempotency_key: key(idempotency_key) },
        call,
      );
      return booking;
    },
  };
}
