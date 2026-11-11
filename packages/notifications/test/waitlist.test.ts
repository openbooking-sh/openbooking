import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, Waitlist } from '@openbooking-sh/core';
import { DATE, DayProvider } from '../../core/test/day-provider';
import { MemoryMailer, attachWaitlistNotifications, renderWaitlistOfferEmail } from '../src';

const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const bob = { first_name: 'Bob', last_name: 'Builder', phone_number: '+4712345678' };

function setup(over: { isSuppressed?: (email: string) => boolean } = {}) {
  const clock = new ManualClock('2026-10-01T12:00:00Z');
  const provider = new DayProvider();
  const service = new BookingService({ provider, clock });
  const waitlist = new Waitlist({ service, offerTtlSeconds: 600 });
  const mailer = new MemoryMailer();
  const handle = attachWaitlistNotifications({
    waitlist,
    mailer,
    config: { from: 'Test Bistro <bookings@openbooking.sh>', replyTo: 'hello@bistro.example' },
    acceptUrl: (b) => `https://bistro.example/book/confirm/${b.booking_id}`,
    ...over,
  });
  let n = 0;
  const key = () => `key-${String(++n).padStart(6, '0')}`;
  const book = async (slotId: string) => {
    const held = await service.hold({ slot_id: slotId, idempotency_key: key(), customer: bob });
    return service.confirm({
      booking_id: held.booking_id,
      idempotency_key: key(),
      user_confirmed: true,
    });
  };
  const join = (customer: typeof ada | typeof bob) =>
    waitlist.join({
      date: DATE,
      party_size: 2,
      customer,
      user_confirmed: true,
      idempotency_key: key(),
    });
  const cancel = (id: string) =>
    service.cancel({ booking_id: id, idempotency_key: key(), user_confirmed: true });
  return { service, waitlist, mailer, handle, book, join, cancel };
}

describe('waitlist offer email', () => {
  it('tells the customer a slot is held, until when, and how to take it', async () => {
    const { waitlist, mailer, handle, book, join, cancel } = setup();
    const b19 = await book('s19');
    await book('s21');
    await join(ada);
    await cancel(b19.booking_id);
    await waitlist.idle();
    await handle.idle();

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('ada@example.com');
    expect(mail.replyTo).toBe('hello@bistro.example');
    expect(mail.subject).toContain('A time opened up');
    expect(mail.text).toContain('Hi Ada');
    expect(mail.text).toContain('not booked until you confirm');
    expect(mail.text).toContain('Held for you until: Thursday 1 October, 12:10');
    expect(mail.text).toMatch(/https:\/\/bistro\.example\/book\/confirm\/b\d+/);
    expect(mail.html).toContain('Review and confirm');
  });

  it('sends one email per offer, and none to a phone-only or unsubscribed customer', async () => {
    const { waitlist, mailer, handle, book, join, cancel } = setup({
      isSuppressed: (email) => email === 'ada@example.com',
    });
    const b19 = await book('s19');
    const b21 = await book('s21');
    await join(ada);
    await join(bob);
    await cancel(b19.booking_id);
    await waitlist.idle();
    await cancel(b21.booking_id);
    await waitlist.idle();
    await handle.idle();
    // Ada is unsubscribed and Bob has no email: both are offered a hold, neither gets mail.
    expect(mailer.sent).toHaveLength(0);
  });

  it('escapes what agents typed', () => {
    const mail = renderWaitlistOfferEmail({
      booking: {
        booking_id: 'b1',
        status: 'held',
        venue_id: 'v1',
        slot: {
          slot_id: 's',
          venue_id: 'v1',
          offering: { id: 'd', name: 'Dinner' },
          start: '2026-10-10T19:00:00+00:00',
          end: '2026-10-10T20:30:00+00:00',
          party_size: { total: 2 },
          price: null,
          deposit: null,
          cancellation_policy: {
            refundability: 'refundable',
            description: 'Free <b>cancellation</b>',
            free_cancellation_until: null,
            late_cancellation_fee: null,
            no_show_fee: null,
          },
        },
        customer: { first_name: '<script>x</script>', last_name: 'L', email: 'a@example.com' },
        notes: null,
        expires_at: '2026-10-01T12:10:00+00:00',
        confirmation_code: null,
        payment: { status: 'not_required', amount: null, reference: null },
        cancellation: null,
        created_at: '2026-10-01T12:00:00+00:00',
        updated_at: '2026-10-01T12:00:00+00:00',
        confirmed_at: null,
        cancelled_at: null,
      },
      venue: { id: 'v1', name: 'Test Bistro', timezone: 'UTC' },
      heldUntil: '2026-10-01T12:10:00+00:00',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });
});
