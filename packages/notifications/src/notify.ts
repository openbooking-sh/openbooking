/**
 * Booking emails driven by BookingService events: a confirmation (with a calendar invite) to the
 * customer, a heads-up to the business, and the same pair when a confirmed booking is cancelled.
 * Sending runs in the background and never affects the booking itself.
 */
import type { Booking, BookingEvent, BookingService } from '@openbooking/core';
import { buildIcs } from './ics';
import {
  MemoryNotificationLog,
  type EmailMessage,
  type Mailer,
  type NotificationLog,
} from './mailer';
import { renderCancellationEmail, renderConfirmationEmail, renderOwnerEmail } from './templates';

export interface NotificationConfig {
  /** Sender, e.g. "Studio Nord <bookings@openbooking.sh>". */
  from: string;
  /** Business contact email; customer replies go here. */
  replyTo?: string;
  /** Receives "new booking" and "booking cancelled" notices. */
  ownerEmail?: string;
  /** Email customers. Default true. */
  customerEmails?: boolean;
  /** Email the business. Default true. */
  ownerEmails?: boolean;
}

export interface NotificationOptions {
  service: BookingService;
  mailer: Mailer;
  /** Read on every send, so settings changes apply without re-attaching. */
  config: NotificationConfig | (() => NotificationConfig | Promise<NotificationConfig>);
  /** Link where the customer can view/cancel the booking (booking page manage link). */
  manageUrl?: (booking: Booking) => string | undefined;
  /** Dedupe across retries and instances. Default in-memory. */
  log?: NotificationLog;
  onError?: (error: unknown) => void;
}

export interface NotificationHandle {
  detach(): void;
  /** Resolves once every email queued so far is sent (or failed). */
  idle(): Promise<void>;
}

export function attachNotifications(options: NotificationOptions): NotificationHandle {
  const { service, mailer } = options;
  const log = options.log ?? new MemoryNotificationLog();
  const onError =
    options.onError ?? ((e: unknown) => console.error('[openbooking] notification failed', e));
  let tail: Promise<void> = Promise.resolve();

  const detach = service.on((event) => {
    const kind = classify(event);
    if (!kind) return;
    tail = tail.then(() => handle(kind, event, event.booking!).catch(onError));
  });

  async function handle(kind: 'confirmed' | 'cancelled', event: BookingEvent, booking: Booking) {
    if (!(await log.claim(`${kind}:${booking.booking_id}`))) return;
    const config = typeof options.config === 'function' ? await options.config() : options.config;
    const venue = await service.resolveVenue(booking.venue_id);
    const manageUrl = kind === 'confirmed' ? options.manageUrl?.(booking) : undefined;
    const sends: EmailMessage[] = [];

    const customerEmail = booking.customer?.email;
    if (config.customerEmails !== false && customerEmail) {
      const method = kind === 'confirmed' ? 'REQUEST' : 'CANCEL';
      const input = { booking, venue, ...(manageUrl ? { manageUrl } : {}) };
      const mail =
        kind === 'confirmed' ? renderConfirmationEmail(input) : renderCancellationEmail(input);
      sends.push({
        to: customerEmail,
        from: config.from,
        ...(config.replyTo ? { replyTo: config.replyTo } : {}),
        ...mail,
        attachments: [
          {
            filename: 'booking.ics',
            contentType: `text/calendar; charset=utf-8; method=${method}`,
            content: buildIcs({
              booking,
              venue,
              method,
              now: service.clock.now(),
              ...(config.replyTo ? { organizerEmail: config.replyTo } : {}),
              ...(manageUrl ? { url: manageUrl } : {}),
            }),
          },
        ],
      });
    }

    // Staff already know about what they did in Studio themselves.
    if (config.ownerEmails !== false && config.ownerEmail && event.actor?.protocol !== 'studio') {
      sends.push({
        to: config.ownerEmail,
        from: config.from,
        ...(customerEmail ? { replyTo: customerEmail } : {}),
        ...renderOwnerEmail({
          kind: kind === 'confirmed' ? 'new' : 'cancelled',
          booking,
          venue,
          channel: event.actor?.agent ?? 'Direct',
        }),
      });
    }

    // One failed send must not stop the other.
    const results = await Promise.allSettled(sends.map((m) => mailer.send(m)));
    for (const r of results) if (r.status === 'rejected') onError(r.reason);
  }

  return { detach, idle: () => tail };
}

function classify(e: BookingEvent): 'confirmed' | 'cancelled' | null {
  if (!e.ok || e.replayed || !e.booking) return null;
  if (e.operation === 'confirm' && e.booking.status === 'confirmed') return 'confirmed';
  // A released hold was never a booking; only cancelled confirmed bookings get emails.
  if (e.operation === 'cancel' && e.booking.status === 'cancelled' && e.booking.confirmed_at) {
    return 'cancelled';
  }
  return null;
}
