import { time } from '@openbooking/core';
import {
  GoogleApiError,
  GoogleAuthError,
  refreshTokens,
  type GoogleCredentials,
  type GoogleTokens,
  type GoogleTokenStore,
} from './oauth';

export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Refresh this long before Google's stated expiry. */
const EXPIRY_SKEW_MS = 60_000;

export interface GoogleEventInput {
  summary: string;
  description?: string;
  location?: string;
  /** RFC 3339 with offset. */
  start: string;
  end: string;
  /** IANA zone the event is shown in. */
  timeZone?: string;
  /** Stored as `extendedProperties.private`; invisible to guests. */
  privateProperties?: Record<string, string>;
}

export interface GoogleCalendarClientOptions {
  credentials: GoogleCredentials;
  tokens: GoogleTokenStore;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The few Google Calendar API calls OpenBooking needs. Keeps the access token fresh: refreshes
 * shortly before expiry, and once more on a 401. Concurrent calls share one refresh.
 */
export class GoogleCalendarClient {
  readonly #creds: GoogleCredentials;
  readonly #tokens: GoogleTokenStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #refreshing: Promise<GoogleTokens> | undefined;

  constructor(opts: GoogleCalendarClientOptions) {
    this.#creds = opts.credentials;
    this.#tokens = opts.tokens;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? Date.now;
  }

  async listCalendars(): Promise<
    Array<{ id: string; summary: string; primary: boolean; timeZone?: string }>
  > {
    const out: Array<{ id: string; summary: string; primary: boolean; timeZone?: string }> = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ minAccessRole: 'reader' });
      if (pageToken) query.set('pageToken', pageToken);
      const page = (await this.#json('GET', `/users/me/calendarList?${query}`)) as {
        items?: Array<{ id: string; summary?: string; primary?: boolean; timeZone?: string }>;
        nextPageToken?: string;
      };
      for (const c of page.items ?? []) {
        out.push({
          id: c.id,
          summary: c.summary ?? c.id,
          primary: c.primary === true,
          ...(c.timeZone ? { timeZone: c.timeZone } : {}),
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Busy periods per calendar id. A calendar Google can't read fails the whole call. */
  async freeBusy(
    calendarIds: string[],
    from: Date,
    to: Date,
  ): Promise<Map<string, Array<{ start: Date; end: Date }>>> {
    const res = (await this.#json('POST', '/freeBusy', {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    })) as {
      calendars?: Record<
        string,
        { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }
      >;
    };
    const out = new Map<string, Array<{ start: Date; end: Date }>>();
    for (const id of calendarIds) {
      const cal = res.calendars?.[id];
      if (!cal || cal.errors?.length) {
        // 502: Google answered, but not for this calendar (e.g. notFound, no access).
        throw new GoogleApiError(
          502,
          `Google couldn't read busy times for calendar ${id}: ${
            cal?.errors?.map((e) => e.reason).join(', ') || 'missing from answer'
          }`,
        );
      }
      out.set(
        id,
        (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
      );
    }
    return out;
  }

  /**
   * Periods a calendar is really busy, from its events. Unlike freeBusy this can leave out
   * events OpenBooking itself created (the booking store already blocks those), so a shared
   * calendar doesn't turn one staff member's booking into everyone's busy time. Skips cancelled,
   * free ("transparent") and declined events. All-day events cover the whole local day.
   */
  async listBusyEvents(
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: Date; end: Date }>> {
    const out: Array<{ start: Date; end: Date }> = [];
    let pageToken: string | undefined;
    let timeZone: string | undefined;
    do {
      const query = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      });
      if (pageToken) query.set('pageToken', pageToken);
      const page = (await this.#json(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
      )) as { timeZone?: string; items?: GoogleEventResource[]; nextPageToken?: string };
      timeZone ??= page.timeZone;
      for (const e of page.items ?? []) {
        if (!blocksTime(e)) continue;
        const start = instantOf(e.start, timeZone);
        const end = instantOf(e.end, timeZone);
        if (!start || !end) continue;
        if (start < to && from < end) out.push({ start, end });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async insertEvent(calendarId: string, event: GoogleEventInput): Promise<{ id: string }> {
    const tz = event.timeZone ? { timeZone: event.timeZone } : {};
    const res = (await this.#json(
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
      {
        summary: event.summary,
        ...(event.description ? { description: event.description } : {}),
        ...(event.location ? { location: event.location } : {}),
        start: { dateTime: event.start, ...tz },
        end: { dateTime: event.end, ...tz },
        ...(event.privateProperties
          ? { extendedProperties: { private: event.privateProperties } }
          : {}),
      },
    )) as { id: string };
    return { id: res.id };
  }

  /** Delete an event. Already deleted (404/410) counts as done. */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const res = await this.#request(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    );
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw await apiError(res);
  }

  // ---------------------------------------------------------------------------

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#request(method, path, body);
    if (!res.ok) throw await apiError(res);
    return res.json();
  }

  async #request(method: string, path: string, body?: unknown, retry = true): Promise<Response> {
    const token = await this.#accessToken(false);
    const res = await this.#fetch(`${GOOGLE_CALENDAR_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && retry) {
      await this.#accessToken(true);
      return this.#request(method, path, body, false);
    }
    return res;
  }

  async #accessToken(force: boolean): Promise<string> {
    if (this.#refreshing) return (await this.#refreshing).access_token;
    const tokens = await this.#tokens.get();
    if (!tokens) throw new GoogleAuthError('Google Calendar is not connected.');
    if (!force && tokens.expires_at - EXPIRY_SKEW_MS > this.#now()) return tokens.access_token;
    this.#refreshing ??= (async () => {
      const fresh = await refreshTokens(this.#creds, tokens, this.#fetch, this.#now);
      await this.#tokens.set(fresh);
      return fresh;
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return (await this.#refreshing).access_token;
  }
}

/** The parts of a Google event resource that decide whether it blocks time. */
interface GoogleEventResource {
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}

/** Private property marking events OpenBooking created for its own bookings. */
export const BOOKING_ID_PROPERTY = 'openbooking_booking_id';

function blocksTime(e: GoogleEventResource): boolean {
  if (e.status === 'cancelled' || e.transparency === 'transparent') return false;
  if (e.extendedProperties?.private?.[BOOKING_ID_PROPERTY]) return false;
  const self = e.attendees?.find((a) => a.self);
  return self?.responseStatus !== 'declined';
}

/** An event boundary as an instant; all-day dates are midnight in the calendar's zone. */
function instantOf(
  t: { dateTime?: string; date?: string } | undefined,
  timeZone: string | undefined,
): Date | undefined {
  if (t?.dateTime) return new Date(t.dateTime);
  if (t?.date) return time.zonedToInstant(t.date, '00:00', timeZone ?? 'UTC');
  return undefined;
}

async function apiError(res: Response): Promise<GoogleApiError> {
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return new GoogleApiError(
    res.status,
    `Google Calendar API error ${res.status}: ${json.error?.message ?? res.statusText}`,
  );
}
