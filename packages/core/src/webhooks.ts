/**
 * Webhooks: tell other systems (a CRM, an SMS sender, the integrator's own database) when a
 * booking is held, confirmed, updated or cancelled.
 *
 * Each delivery is a signed JSON POST. The signature header is `t=<unix seconds>,v1=<hex>`, where
 * v1 is HMAC-SHA256 of `${t}.${body}` with the endpoint's secret, so receivers can check both
 * authenticity and freshness; {@link verifyWebhook} does that. Deliveries retry with backoff
 * in-process; on serverless hosts, wait for {@link Webhooks.idle} (e.g. with `waitUntil`) so
 * the function isn't frozen mid-retry. Delivery is at-least-once: receivers should dedupe on
 * the `id` field.
 *
 * Payloads include customer details (it's the integrator's own endpoint), so never point a webhook
 * at an analytics or logging service.
 *
 * Web-standard only (fetch, WebCrypto), so it runs on Node, edge runtimes and Workers.
 */
import type { Actor } from './actor';
import type { Booking } from './schemas';
import type { BookingEvent } from './service';

export const WEBHOOK_EVENT_TYPES = [
  'booking.held',
  'booking.confirmed',
  'booking.updated',
  'booking.cancelled',
  'booking.rescheduled',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  /** Unique per event; the same across retries, so receivers can dedupe. */
  id: string;
  type: WebhookEventType;
  /** ISO 8601. */
  created_at: string;
  data: {
    /** The booking as it is now. For `booking.rescheduled`: the new booking. */
    booking: Booking;
    /** Only `booking.rescheduled`: the booking that was moved, now cancelled. */
    previous_booking?: Booking;
    /** Who made the change, e.g. `{ agent: 'Claude' }` or Studio. */
    actor?: Actor;
  };
}

export interface WebhookEndpoint {
  url: string;
  /** Shared secret for the signature. At least 16 characters; keep it out of source control. */
  secret: string;
  /** Only these event types. Default: all. */
  events?: WebhookEventType[];
}

export interface WebhookOptions {
  endpoints: WebhookEndpoint[];
  fetch?: typeof fetch;
  /** Delay before each retry, in ms. Default 2s, 15s, 60s (four attempts in total). */
  retryDelaysMs?: number[];
  /** Per-attempt timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Called when an endpoint failed every attempt. Default: console.warn (URL and status only). */
  onFailure?: (failure: { endpoint: string; event: WebhookEvent; error: string }) => void;
}

export const WEBHOOK_SIGNATURE_HEADER = 'openbooking-signature';
export const WEBHOOK_ID_HEADER = 'openbooking-event-id';

/** Which successful, non-replayed engine operations become webhook events. */
function eventType(e: BookingEvent): WebhookEventType | undefined {
  if (!e.ok || e.replayed || e.unchanged || e.part_of || !e.booking) return undefined;
  switch (e.operation) {
    case 'hold':
      return 'booking.held';
    case 'confirm':
      return 'booking.confirmed';
    case 'update':
      return 'booking.updated';
    case 'cancel':
      return 'booking.cancelled';
    case 'reschedule':
      return 'booking.rescheduled';
    default:
      return undefined;
  }
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The value of the signature header for `body` at `timestamp` (unix seconds). */
export async function signWebhook(
  body: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/**
 * Check a delivery on the receiving side: the signature matches and is at most `toleranceSeconds`
 * old (default 300). Pass the raw request body, not re-serialized JSON.
 */
export async function verifyWebhook(
  body: string,
  signatureHeader: string | null | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? 300)) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  // Constant-time comparison.
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

export interface Webhooks {
  /** Pass to `BookingService.on()` or the `onEvent` option. */
  listener: (event: BookingEvent) => void;
  /** Resolves when every delivery started so far has succeeded or given up. */
  idle(): Promise<void>;
}

/**
 * Deliver booking events to webhook endpoints.
 *
 * ```ts
 * const webhooks = createWebhooks({ endpoints: [{ url, secret: process.env.WEBHOOK_SECRET! }] });
 * service.on(webhooks.listener);
 * ```
 */
export function createWebhooks(options: WebhookOptions): Webhooks {
  for (const e of options.endpoints) {
    if (!/^https?:\/\//.test(e.url)) throw new Error(`Webhook URL must be http(s): ${e.url}`);
    if (e.secret.length < 16) throw new Error('Webhook secret must be at least 16 characters');
  }
  const doFetch = options.fetch ?? fetch;
  const delays = options.retryDelaysMs ?? [2_000, 15_000, 60_000];
  const timeoutMs = options.timeoutMs ?? 10_000;
  const onFailure =
    options.onFailure ??
    ((f) => console.warn(`[openbooking] webhook to ${f.endpoint} failed: ${f.error}`));
  const pending = new Set<Promise<void>>();

  async function deliver(endpoint: WebhookEndpoint, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify(event);
    let error = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      try {
        // Signed per attempt, so the timestamp stays fresh for receivers' tolerance window.
        const signature = await signWebhook(body, endpoint.secret, Math.floor(Date.now() / 1000));
        const res = await doFetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'OpenBooking-Webhooks/1',
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_ID_HEADER]: event.id,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return;
        error = `HTTP ${res.status}`;
        // 4xx other than timeout/rate limit won't get better by retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
          break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    onFailure({ endpoint: endpoint.url, event, error });
  }

  return {
    listener(e) {
      const type = eventType(e);
      if (!type || !e.booking) return;
      const event: WebhookEvent = {
        id: `evt_${crypto.randomUUID()}`,
        type,
        created_at: e.at,
        data: {
          booking: e.booking,
          ...(e.previous ? { previous_booking: e.previous } : {}),
          ...(e.actor ? { actor: e.actor } : {}),
        },
      };
      for (const endpoint of options.endpoints) {
        if (endpoint.events && !endpoint.events.includes(type)) continue;
        const p = deliver(endpoint, event);
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    },
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
