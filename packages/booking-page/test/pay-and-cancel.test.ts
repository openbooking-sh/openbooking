import { describe, expect, it } from 'vitest';
import { BookingService, ManualClock, type PaymentProvider } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import { createBookingPage } from '../src';
import { MANAGE_SCRIPT, PAGE_SCRIPT } from '../src/client';
import { runScript } from './browser';

const BASE = 'https://app.example.com/b/studio-nord';
const API = '/b/studio-nord/book';
const ADA = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

/** A Wednesday-to-Friday at least three days ahead: the salon is open and the free window is open. */
function bookableDay(from: Date): string {
  const d = new Date(from.getTime() + 3 * 86_400_000);
  while (![3, 4, 5].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A payment company that remembers who paid and what it refunded. */
function fakePayments() {
  const paid = new Set<string>();
  const refunds: number[] = [];
  const provider: PaymentProvider = {
    createCheckout: async ({ booking }) => ({
      url: `https://pay.example/${booking.booking_id}`,
      token: `tok_${booking.booking_id}`,
    }),
    verify: async (token) => {
      const id = token.replace('tok_', '');
      return {
        paid: paid.has(id),
        amount: { amount: 30000, currency: 'NOK' },
        booking_id: id,
        reference: `ref_${id}`,
      };
    },
    refund: async (r) => void refunds.push(r.amount.amount),
  };
  return { provider, paid, refunds };
}

function setup() {
  const clock = new ManualClock(Date.now());
  const payments = fakePayments();
  const service = new BookingService({
    provider: createDemoSalonProvider(),
    clock,
    payments: payments.provider,
  });
  const page = createBookingPage({ service, pageUrl: BASE, apiBase: `${BASE}/book` });
  const day = bookableDay(clock.now());
  const post = async (path: string, body: unknown) => {
    const res = await page.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as any;
  };
  /** Colour and cut, with its 300 NOK deposit: held, paid, confirmed. */
  const bookWithDeposit = async () => {
    const slots = await (
      await page.app.request(`/api/availability?date=${day}&service=color-cut`)
    ).json();
    const held = await post('/api/hold', {
      slot_id: (slots as any).slots[0].slot_id,
      idempotency_key: 'hold-key-0001',
    });
    const id = held.booking.booking_id as string;
    const body = {
      booking_id: id,
      idempotency_key: 'confirm-key-1',
      customer: ADA,
      user_confirmed: true,
    };
    expect((await post('/api/confirm', body)).error.code).toBe('payment_required');
    payments.paid.add(id);
    const done = await post('/api/confirm', { ...body, payment_token: `tok_${id}` });
    expect(done.booking.status).toBe('confirmed');
    return done.booking as { booking_id: string; start: string; confirmation_code: string };
  };
  const manage = async (b: { booking_id: string; confirmation_code: string }) => {
    const html = await (
      await page.app.request(`/manage/${b.booking_id}?code=${b.confirmation_code}`)
    ).text();
    return runScript(MANAGE_SCRIPT, page, html, {
      pathname: `${API}/manage/${b.booking_id}`,
      search: `?code=${b.confirmation_code}`,
    });
  };
  return { clock, service, page, payments, day, post, bookWithDeposit, manage };
}

describe('terms next to the pay button', () => {
  it('names the amount on the button and what happens to the deposit if the customer cancels', async () => {
    const t = setup();
    const html = await t.page.html({ service: 'color-cut', date: t.day });
    const b = runScript(PAGE_SCRIPT, t.page, html, { pathname: '/b/studio-nord', search: '' });
    await b.until(() => b.el('times').innerHTML.includes('data-i'), 'the free times');
    b.el('times').querySelectorAll('.chip')[0]!.onclick!();
    await b.until(() => b.el('review').innerHTML.includes('Deposit'), 'the hold');

    expect(b.el('pay-note').classList.contains('hidden')).toBe(false);
    expect(b.el('confirm').textContent).toMatch(/^Pay .*300.* deposit$/);
    const note = b.el('pay-note').innerHTML;
    expect(note).toContain('You pay');
    expect(note).toContain('Stripe');
    // Free for a day, then the late fee (300 NOK) equals the deposit, so none of it comes back.
    expect(note).toContain('Cancel free until');
    expect(note).toContain('the deposit is refunded in full');
    expect(note).toContain('After that, the deposit is not refunded if you cancel.');
  });

  it('shows no payment terms for a service without a deposit', async () => {
    const t = setup();
    const html = await t.page.html({ service: 'haircut', date: t.day });
    const b = runScript(PAGE_SCRIPT, t.page, html, { pathname: '/b/studio-nord', search: '' });
    await b.until(() => b.el('times').innerHTML.includes('data-i'), 'the free times');
    b.el('times').querySelectorAll('.chip')[0]!.onclick!();
    await b.until(() => b.el('review').innerHTML.includes('Cancellation'), 'the hold');
    expect(b.el('pay-note').classList.contains('hidden')).toBe(true);
    expect(b.el('confirm').textContent).toBe('Confirm booking');
  });
});

describe('cancelling from the manage page', () => {
  it('says what cancelling costs before the button is pressed', async () => {
    const t = setup();
    const booked = await t.bookWithDeposit();
    const m = await t.manage(booked);
    await m.until(() => m.el('now').textContent !== '', 'the cancellation terms');
    expect(m.el('now').textContent).toMatch(
      /^Cancelling now is free\. Your deposit of .*300.* is refunded\.$/,
    );
  });

  it('cancels with one press while it is free, and refunds the deposit', async () => {
    const t = setup();
    const booked = await t.bookWithDeposit();
    const m = await t.manage(booked);
    await m.until(() => m.el('now').textContent !== '', 'the cancellation terms');

    m.el('cancel').onclick!();
    await m.until(() => m.el('body').innerHTML.includes('Cancelled'), 'the cancellation');

    const after = await t.service.getBooking(booked.booking_id);
    expect(after.status).toBe('cancelled');
    expect(t.payments.refunds).toEqual([30000]);
    expect(m.el('err').textContent).toBe('');
  });

  it('asks again, and does not cancel, when the free time ran out after the page was opened', async () => {
    const t = setup();
    const booked = await t.bookWithDeposit();
    const m = await t.manage(booked);
    await m.until(() => m.el('now').textContent !== '', 'the cancellation terms');
    // The page said "free". Then the day before the booking begins, and the fee starts.
    t.clock.set(new Date(new Date(booked.start).getTime() - 2 * 3_600_000));

    m.el('cancel').onclick!();
    await m.until(() => !m.el('terms').classList.contains('hidden'), 'the fee warning');

    expect(m.el('terms').textContent).toContain('Cancelling now costs');
    expect(m.el('cancel').textContent).toBe('Yes, cancel my booking');
    expect((await t.service.getBooking(booked.booking_id)).status).toBe('confirmed');
    expect(t.payments.refunds).toEqual([]);

    // The second press is the yes to the fee.
    m.el('cancel').onclick!();
    await m.until(() => m.el('body').innerHTML.includes('Cancelled'), 'the cancellation');
    const after = await t.service.getBooking(booked.booking_id);
    expect(after.status).toBe('cancelled');
    expect(after.cancellation?.fee?.amount).toBe(30000);
  });

  it('shows the fee up front when it already applies, and still asks before charging it', async () => {
    const t = setup();
    const booked = await t.bookWithDeposit();
    t.clock.set(new Date(new Date(booked.start).getTime() - 2 * 3_600_000));
    const m = await t.manage(booked);
    await m.until(() => m.el('now').textContent !== '', 'the cancellation terms');
    expect(m.el('now').textContent).toMatch(/^Cancelling now costs .*300.*\./);

    m.el('cancel').onclick!();
    await m.until(() => !m.el('terms').classList.contains('hidden'), 'the fee warning');
    expect((await t.service.getBooking(booked.booking_id)).status).toBe('confirmed');
  });

  it('reports what cancelling costs in the booking API, and nothing once it is cancelled', async () => {
    const t = setup();
    const booked = await t.bookWithDeposit();
    const read = async () =>
      (
        (await (
          await t.page.app.request(
            `/api/bookings/${booked.booking_id}?code=${booked.confirmation_code}`,
          )
        ).json()) as any
      ).booking;
    expect((await read()).cancel_now).toEqual({
      free: true,
      fee: null,
      refund: { amount: 30000, currency: 'NOK' },
    });
    await t.post('/api/bookings/' + booked.booking_id + '/cancel', {
      code: booked.confirmation_code,
      idempotency_key: 'cancel-key-1',
      user_confirmed: true,
    });
    expect((await read()).cancel_now).toBeNull();
  });
});
