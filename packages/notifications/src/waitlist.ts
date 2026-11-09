/**
 * The waitlist email: when a slot is held for someone who was waiting, tell them. Sending runs in
 * the background and never affects the waitlist. Nothing here is logged with a name or address.
 */
import type { Booking, Waitlist } from '@openbooking-sh/core';
import type { NotificationConfig } from './notify';
import { MemoryNotificationLog, type Mailer, type NotificationLog } from './mailer';
import { renderWaitlistOfferEmail } from './templates';

export interface WaitlistNotificationOptions {
  waitlist: Waitlist;
  mailer: Mailer;
  /** Read on every send. Same settings as booking emails. */
  config: NotificationConfig | (() => NotificationConfig | Promise<NotificationConfig>);
  /** Where the customer reviews and confirms the held booking (the booking page's confirm link). */
  acceptUrl?: (booking: Booking) => string | undefined;
  /** True when this address unsubscribed: nothing is sent and the hold simply lapses. */
  isSuppressed?: (customerEmail: string) => boolean | Promise<boolean>;
  /** Dedupe across retries and instances. Default in-memory. */
  log?: NotificationLog;
  onError?: (error: unknown) => void;
}

export interface WaitlistNotificationHandle {
  detach(): void;
  /** Resolves once every email queued so far is sent (or failed). */
  idle(): Promise<void>;
}

export function attachWaitlistNotifications(
  options: WaitlistNotificationOptions,
): WaitlistNotificationHandle {
  const { waitlist, mailer } = options;
  const log = options.log ?? new MemoryNotificationLog();
  const onError =
    options.onError ?? ((e: unknown) => console.error('[openbooking] waitlist email failed', e));
  let tail: Promise<void> = Promise.resolve();

  const detach = waitlist.on((event) => {
    if (event.type !== 'offered' || !event.booking) return;
    const { entry, booking } = event;
    tail = tail.then(async () => {
      try {
        const to = entry.customer.email;
        if (!to) return; // phone only: the staff or agent has to pass the offer on
        if (!(await log.claim(`waitlist-offer:${entry.waitlist_id}`))) return;
        const config =
          typeof options.config === 'function' ? await options.config() : options.config;
        if (config.customerEmails === false || (await options.isSuppressed?.(to))) return;
        const venue = await waitlist.service.resolveVenue(booking.venue_id);
        const unsubscribeUrl = config.unsubscribeUrl?.(to);
        const acceptUrl = options.acceptUrl?.(booking);
        const mail = renderWaitlistOfferEmail({
          booking,
          venue,
          heldUntil: entry.offer?.expires_at ?? booking.expires_at ?? booking.slot.start,
          ...(acceptUrl ? { acceptUrl } : {}),
          ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
          ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
        });
        await mailer.send({
          to,
          from: config.from,
          ...(config.replyTo ? { replyTo: config.replyTo } : {}),
          ...mail,
          ...(unsubscribeUrl
            ? {
                headers: {
                  'List-Unsubscribe': `<${unsubscribeUrl}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                },
              }
            : {}),
        });
      } catch (e) {
        onError(e);
      }
    });
  });

  return { detach, idle: () => tail };
}
