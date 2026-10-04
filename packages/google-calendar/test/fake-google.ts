/** A tiny in-memory Google (OAuth token endpoint + the Calendar calls we use), as a fetch. */
import type { GoogleTokens } from '../src';

export interface FakeEvent {
  id: string;
  body: any;
}

export function createFakeGoogle() {
  let tokenSeq = 1;
  let eventSeq = 0;
  const google = {
    accessToken: 'at_1',
    refreshes: 0,
    /** Token endpoint answers refresh with invalid_grant. */
    revoked: false,
    /** Next calendar API call gets a 401 regardless of token. */
    reject401Once: false,
    /** HTTP status for freeBusy (200 = normal). */
    freeBusyStatus: 200,
    freeBusyCalls: 0,
    busy: {} as Record<string, Array<{ start: string; end: string }>>,
    /** HTTP status for events.list (200 = normal). */
    eventsStatus: 200,
    listCalls: 0,
    /** events.list page size, to exercise pagination. */
    pageSize: 250,
    events: new Map<string, FakeEvent[]>(),
    /** Seed an event (Google event resource shape) on a calendar. */
    addEvent(calendarId: string, body: any) {
      const list = google.events.get(calendarId) ?? [];
      google.events.set(calendarId, list);
      list.push({ id: `ev_${++eventSeq}`, body });
    },
    calendars: [
      { id: 'owner@example.com', summary: 'Studio Nord', primary: true, timeZone: 'Europe/Oslo' },
      { id: 'maria@cal', summary: 'Maria' } as {
        id: string;
        summary: string;
        primary?: boolean;
        timeZone?: string;
      },
    ],
    idToken: (email: string) =>
      `h.${Buffer.from(JSON.stringify({ email, sub: '1' })).toString('base64url')}.sig`,

    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url.href === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('grant_type') === 'authorization_code') {
          if (form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
          return json(200, {
            access_token: google.accessToken,
            refresh_token: 'rt_1',
            expires_in: 3599,
            scope: 'openid email',
            id_token: google.idToken('owner@example.com'),
          });
        }
        if (google.revoked || form.get('refresh_token') !== 'rt_1') {
          return json(400, {
            error: 'invalid_grant',
            error_description: 'Token has been revoked.',
          });
        }
        google.refreshes++;
        google.accessToken = `at_${++tokenSeq}`;
        return json(200, { access_token: google.accessToken, expires_in: 3599 });
      }

      const path = url.pathname.replace('/calendar/v3', '');
      const auth = new Headers(init?.headers).get('authorization');
      if (google.reject401Once || auth !== `Bearer ${google.accessToken}`) {
        google.reject401Once = false;
        return json(401, { error: { message: 'Invalid Credentials' } });
      }

      if (method === 'GET' && path === '/users/me/calendarList') {
        return json(200, { items: google.calendars });
      }
      if (method === 'POST' && path === '/freeBusy') {
        google.freeBusyCalls++;
        if (google.freeBusyStatus !== 200) {
          return json(google.freeBusyStatus, { error: { message: 'Backend Error' } });
        }
        const body = JSON.parse(String(init?.body)) as {
          timeMin: string;
          timeMax: string;
          items: Array<{ id: string }>;
        };
        const calendars: Record<string, unknown> = {};
        for (const { id } of body.items) {
          calendars[id] =
            id === 'missing@cal'
              ? { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] }
              : {
                  busy: (google.busy[id] ?? []).filter(
                    (b) => b.start < body.timeMax && body.timeMin < b.end,
                  ),
                };
        }
        return json(200, { calendars });
      }
      const ev = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (ev) {
        const cal = decodeURIComponent(ev[1]!);
        if (method === 'GET' && !ev[2]) {
          google.listCalls++;
          if (google.eventsStatus !== 200) {
            return json(google.eventsStatus, { error: { message: 'Backend Error' } });
          }
          if (cal === 'missing@cal') return json(404, { error: { message: 'Not Found' } });
          const q = url.searchParams;
          const timeMin = new Date(q.get('timeMin')!).getTime();
          const timeMax = new Date(q.get('timeMax')!).getTime();
          const at = (t: { dateTime?: string; date?: string }) =>
            new Date(t.dateTime ?? `${t.date}T00:00:00Z`).getTime();
          // All-day events are returned whenever they're on a nearby day; the client decides.
          const items = (google.events.get(cal) ?? [])
            .map((e) => ({ id: e.id, ...e.body }))
            .filter((e) => at(e.start) < timeMax + 86_400_000 && timeMin - 86_400_000 < at(e.end));
          const offset = Number(q.get('pageToken') ?? 0);
          const page = items.slice(offset, offset + google.pageSize);
          const next = offset + google.pageSize < items.length ? offset + google.pageSize : null;
          const tz = google.calendars.find((c) => c.id === cal)?.timeZone;
          return json(200, {
            ...(tz ? { timeZone: tz } : {}),
            items: page,
            ...(next !== null ? { nextPageToken: String(next) } : {}),
          });
        }
        const list = google.events.get(cal) ?? [];
        google.events.set(cal, list);
        if (method === 'POST') {
          const event = { id: `ev_${++eventSeq}`, body: JSON.parse(String(init?.body)) };
          list.push(event);
          return json(200, { id: event.id, ...event.body });
        }
        if (method === 'DELETE') {
          const i = list.findIndex((e) => e.id === decodeURIComponent(ev[2]!));
          if (i < 0) return json(410, { error: { message: 'Resource has been deleted' } });
          list.splice(i, 1);
          return new Response(null, { status: 204 });
        }
      }
      return json(404, { error: { message: `No route ${method} ${path}` } });
    }) as typeof fetch,
  };
  return google;
}

export function memoryTokens(initial?: GoogleTokens) {
  let tokens = initial;
  return {
    get: async () => tokens,
    set: async (t: GoogleTokens) => {
      tokens = t;
    },
    get current() {
      return tokens;
    },
  };
}
