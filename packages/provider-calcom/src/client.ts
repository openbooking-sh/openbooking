/**
 * Minimal Cal.com API v2 client (https://cal.com/docs/api-reference/v2). Each endpoint pins its
 * own `cal-api-version`, as the docs require; without it Cal.com silently falls back to an older
 * version of the endpoint.
 */
import { BookingError } from '@openbooking-sh/core';

export const CAL_API_VERSIONS = {
  slots: '2024-09-04',
  bookings: '2026-02-25',
  eventTypes: '2026-06-12',
} as const;

export interface CalEventType {
  id: number;
  title: string;
  slug?: string;
  lengthInMinutes: number;
  description?: string | null;
  price?: number | null;
  currency?: string | null;
  hidden?: boolean;
}

export interface CalSlot {
  start: string;
  end?: string;
}

export interface CalReservation {
  reservationUid: string;
  reservationUntil: string;
  slotStart: string;
  slotEnd?: string;
}

export interface CalBooking {
  id?: number;
  uid: string;
  status: 'accepted' | 'pending' | 'cancelled' | 'rejected' | 'awaiting_host' | string;
  start: string;
  end: string;
  cancellationReason?: string | null;
}

export class CalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CalApiError';
  }
}

export interface CalClientOptions {
  apiKey: string;
  /** Default https://api.cal.com. Point at your own instance for Cal.diy. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class CalClient {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: CalClientOptions) {
    this.#apiKey = options.apiKey;
    this.#base = (options.baseUrl ?? 'https://api.cal.com').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  async #request<T>(
    method: string,
    path: string,
    version: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'cal-api-version': version,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (e) {
      throw new BookingError('provider_error', 'Could not reach Cal.com.', { cause: e });
    }
    const text = await res.text();
    let json: { status?: string; data?: unknown; error?: { message?: string } } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // non-JSON error page
    }
    if (!res.ok || json.status === 'error') {
      const message = json.error?.message ?? (text.slice(0, 200) || res.statusText);
      throw new CalApiError(res.status, message);
    }
    return json.data as T;
  }

  /** Visible event types of the authenticated user. */
  async listEventTypes(): Promise<CalEventType[]> {
    const data = await this.#request<unknown>(
      'GET',
      '/v2/event-types',
      CAL_API_VERSIONS.eventTypes,
    );
    // Shape varies across versions: either an array or { eventTypes: [...] }.
    const list = Array.isArray(data)
      ? data
      : ((data as { eventTypes?: unknown[] })?.eventTypes ?? []);
    return list as CalEventType[];
  }

  /** Slots between two UTC dates, keyed by date, with start/end (format=range). */
  async getSlots(q: {
    eventTypeId: number;
    start: string;
    end: string;
    timeZone: string;
  }): Promise<Record<string, CalSlot[]>> {
    return this.#request('GET', '/v2/slots', CAL_API_VERSIONS.slots, {
      query: { ...q, format: 'range' },
    });
  }

  async reserveSlot(body: {
    eventTypeId: number;
    slotStart: string;
    reservationDuration?: number;
  }): Promise<CalReservation> {
    return this.#request('POST', '/v2/slots/reservations', CAL_API_VERSIONS.slots, { body });
  }

  async deleteReservation(uid: string): Promise<void> {
    await this.#request(
      'DELETE',
      `/v2/slots/reservations/${encodeURIComponent(uid)}`,
      CAL_API_VERSIONS.slots,
    );
  }

  async createBooking(body: {
    start: string;
    eventTypeId: number;
    attendee: { name: string; email: string; timeZone: string; phoneNumber?: string };
    metadata?: Record<string, string>;
  }): Promise<CalBooking> {
    return this.#request('POST', '/v2/bookings', CAL_API_VERSIONS.bookings, { body });
  }

  async getBooking(uid: string): Promise<CalBooking> {
    return this.#request(
      'GET',
      `/v2/bookings/${encodeURIComponent(uid)}`,
      CAL_API_VERSIONS.bookings,
    );
  }

  async cancelBooking(uid: string, cancellationReason?: string): Promise<CalBooking> {
    return this.#request(
      'POST',
      `/v2/bookings/${encodeURIComponent(uid)}/cancel`,
      CAL_API_VERSIONS.bookings,
      {
        body: cancellationReason ? { cancellationReason } : {},
      },
    );
  }
}
