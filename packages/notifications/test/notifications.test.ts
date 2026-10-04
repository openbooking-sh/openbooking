import { describe, expect, it, vi } from 'vitest';
import { BookingService, ManualClock, runAsActor, type Booking } from '@openbooking/core';
import { createDemoSalonProvider } from '@openbooking/provider-memory';
import {
  MemoryMailer,
  ResendMailer,
  attachNotifications,
  buildIcs,
  type EmailMessage,
  type Mailer,
} from '../src';

const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

function setup(mailer: Mailer = new MemoryMailer(), onError?: (e: unknown) => void) {
  // Tuesday morning; the booking is on Friday.
  const clock = new ManualClock('2026-10-06T07:00:00Z');
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const notifications = attachNotifications({
    service,
    mailer,
    config: {
      from: 'Studio Nord <bookings@openbooking.sh>',
      replyTo: 'hello@studionord.example',
      ownerEmail: 'owner@studionord.example',
    },
    manageUrl: (b) => `https://openbooking.sh/b/studio-nord/manage/${b.booking_id}`,
    ...(onError ? { onError } : {}),
  });
  return { service, notifications, clock };
}

async function hold(service: BookingService, key = 'hold-0001') {
  const { slots } = await service.searchAvailability({
    date: '2026-10-09',
    party_size: { total: 1 },
    offering_id: 'haircut',
    time_from: '15:00',
  });
  return service.hold({ slot_id: slots[0]!.slot_id, idempotency_key: key, customer: ada });
}

async function book(service: BookingService): Promise<Booking> {
  const h = await hold(service);
  return service.confirm({
    booking_id: h.booking_id,
    idempotency_key: 'confirm-0001',
    user_confirmed: true,
  });
}

describe('attachNotifications', () => {
  it('emails the customer a confirmation with an invite, and tells the owner', async () => {
    const mailer = new MemoryMailer();
    const { service, notifications } = setup(mailer);
    const booking = await runAsActor({ protocol: 'mcp', agent: 'Claude' }, () => book(service));
    await notifications.idle();

    expect(mailer.sent).toHaveLength(2);
    const [customer, owner] = mailer.sent as [EmailMessage, EmailMessage];
    expect(customer.to).toBe('ada@example.com');
    expect(customer.replyTo).toBe('hello@studionord.example');
    expect(customer.subject).toContain('Booking confirmed: Haircut');
    expect(customer.text).toContain('Friday 9 October, 15:00');
    expect(customer.text).toContain(booking.confirmation_code!);
    expect(customer.text).toContain(booking.slot.cancellation_policy.description);
    expect(customer.html).toContain(`/manage/${booking.booking_id}`);
    const ics = customer.attachments![0]!;
    expect(ics.filename).toBe('booking.ics');
    expect(ics.contentType).toContain('method=REQUEST');
    expect(ics.content).toContain('METHOD:REQUEST');
    expect(ics.content).toContain(`UID:${booking.booking_id}@openbooking.sh`);
    expect(ics.content).toContain('DTSTART:20261009T130000Z');

    expect(owner.to).toBe('owner@studionord.example');
    expect(owner.subject).toBe('New booking: Haircut, Fri 9 Oct 15:00 — Ada Lovelace (via Claude)');
    expect(owner.text).toContain('ada@example.com');
  });

  it('does not email the owner about bookings staff made in Studio', async () => {
    const mailer = new MemoryMailer();
    const { service, notifications } = setup(mailer);
    await runAsActor({ protocol: 'studio', agent: 'Studio' }, () => book(service));
    await notifications.idle();
    expect(mailer.sent.map((m) => m.to)).toEqual(['ada@example.com']);
  });

  it('sends once when an agent confirms again with a fresh key', async () => {
    const mailer = new MemoryMailer();
    const { service, notifications } = setup(mailer);
    const booking = await book(service);
    await service.confirm({
      booking_id: booking.booking_id,
      idempotency_key: 'confirm-0002',
      user_confirmed: true,
    });
    await service.confirm({
      booking_id: booking.booking_id,
      idempotency_key: 'confirm-0001',
      user_confirmed: true,
    });
    await notifications.idle();
    expect(mailer.sent).toHaveLength(2);
  });

  it('sends nothing for a released hold', async () => {
    const mailer = new MemoryMailer();
    const { service, notifications } = setup(mailer);
    const h = await hold(service);
    await service.cancel({ booking_id: h.booking_id, idempotency_key: 'release-0001' });
    await notifications.idle();
    expect(mailer.sent).toHaveLength(0);
  });

  it('sends a cancellation with METHOD:CANCEL when a confirmed booking is cancelled', async () => {
    const mailer = new MemoryMailer();
    const { service, notifications } = setup(mailer);
    const booking = await book(service);
    await runAsActor({ protocol: 'mcp', agent: 'ChatGPT' }, () =>
      service.cancel({
        booking_id: booking.booking_id,
        idempotency_key: 'cancel-0001',
        user_confirmed: true,
      }),
    );
    // Cancelling again is a no-op and must not email again.
    await service.cancel({
      booking_id: booking.booking_id,
      idempotency_key: 'cancel-0002',
      user_confirmed: true,
    });
    await notifications.idle();

    const cancels = mailer.sent.slice(2);
    expect(cancels.map((m) => m.to)).toEqual(['ada@example.com', 'owner@studionord.example']);
    expect(cancels[0]!.subject).toContain('Booking cancelled');
    expect(cancels[0]!.attachments![0]!.content).toContain('METHOD:CANCEL');
    expect(cancels[0]!.attachments![0]!.content).toContain('STATUS:CANCELLED');
    expect(cancels[0]!.attachments![0]!.contentType).toContain('method=CANCEL');
    expect(cancels[1]!.subject).toContain('(via ChatGPT)');
  });

  it('reports mailer failures without affecting the booking', async () => {
    const onError = vi.fn();
    const failing: Mailer = { send: async () => Promise.reject(new Error('smtp down')) };
    const { service, notifications } = setup(failing, onError);
    const booking = await book(service);
    await notifications.idle();
    expect(booking.status).toBe('confirmed');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('escapes customer data in HTML', async () => {
    const mailer = new MemoryMailer();
    const { service, notifications } = setup(mailer);
    const { slots } = await service.searchAvailability({
      date: '2026-10-09',
      party_size: { total: 1 },
      offering_id: 'haircut',
    });
    const h = await service.hold({
      slot_id: slots[0]!.slot_id,
      idempotency_key: 'hold-xxxx',
      customer: { first_name: '<script>', last_name: 'X', email: 'x@example.com' },
      notes: '<img src=x>',
    });
    await service.confirm({
      booking_id: h.booking_id,
      idempotency_key: 'confirm-x',
      user_confirmed: true,
    });
    await notifications.idle();
    for (const m of mailer.sent) {
      expect(m.html).not.toContain('<script>');
      expect(m.html).not.toContain('<img src=x>');
    }
  });
});

describe('buildIcs', () => {
  it('uses CRLF, escapes text and folds long lines at 75 octets', async () => {
    const { service } = setup();
    const booking = await book(service);
    const venue = await service.resolveVenue(booking.venue_id);
    const ics = buildIcs({
      booking: {
        ...booking,
        slot: { ...booking.slot, offering: { id: 'x', name: 'Cut; wash, and \\ style' } },
      },
      venue: { ...venue, name: 'Studio Nord '.repeat(8).trim() },
      method: 'REQUEST',
      organizerEmail: 'hello@studionord.example',
      now: new Date('2026-10-06T07:00:00Z'),
    });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Cut\\; wash\\, and \\\\ style at Studio Nord');
    expect(unfolded).toContain('DTSTAMP:20261006T070000Z');
    expect(unfolded).toContain('ORGANIZER;CN="Studio Nord');
    expect(unfolded).toContain('PARTSTAT=ACCEPTED:mailto:ada@example.com');
    expect(unfolded).toContain('STATUS:CONFIRMED');
    expect(unfolded).toContain('SEQUENCE:0');
    expect(unfolded).toContain('PRODID:-//OpenBooking//EN');
  });
});

describe('ResendMailer', () => {
  it('posts the message to the Resend API', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const mailer = new ResendMailer({ apiKey: 're_test', fetch: fakeFetch });
    await mailer.send({
      to: 'ada@example.com',
      from: 'Studio Nord <bookings@openbooking.sh>',
      replyTo: 'hello@studionord.example',
      subject: 'Hi',
      text: 'text',
      html: '<p>html</p>',
      attachments: [
        { filename: 'booking.ics', content: 'BEGIN:VCALENDAR', contentType: 'text/calendar' },
      ],
    });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      from: 'Studio Nord <bookings@openbooking.sh>',
      to: ['ada@example.com'],
      reply_to: 'hello@studionord.example',
      subject: 'Hi',
      attachments: [
        {
          filename: 'booking.ics',
          content: Buffer.from('BEGIN:VCALENDAR').toString('base64'),
          content_type: 'text/calendar',
        },
      ],
    });
  });

  it('throws with the status on a non-2xx response', async () => {
    const fakeFetch = (async () =>
      new Response('invalid from', { status: 422 })) as unknown as typeof fetch;
    const mailer = new ResendMailer({ apiKey: 're_test', fetch: fakeFetch });
    await expect(
      mailer.send({ to: 'a@b.co', from: 'x@y.co', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow(/422.*invalid from/);
  });
});
