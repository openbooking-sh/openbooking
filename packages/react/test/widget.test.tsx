// @vitest-environment happy-dom
/**
 * The widget in a browser-like page, against a real server over real HTTP: a customer picks a
 * time, reads the terms, ticks the box and books.
 */
import type { OpenBookingClient, Slot } from '@openbooking-sh/client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BookingWidget } from '../src';
import { DATE, startServer, type TestServer } from './server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  server.sent.length = 0;
});

const widget = (extra: Partial<Parameters<typeof BookingWidget>[0]> = {}) =>
  render(<BookingWidget client={server.client} date={DATE} service="haircut" {...extra} />);

const firstTime = async () => {
  const times = await screen.findByRole('list', { name: 'Free times' });
  return within(times).getAllByRole('button')[0]!;
};

const fillIn = () => {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Lovelace' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
};

const posts = (suffix: string) =>
  server.sent.filter((s) => s.method === 'POST' && s.path.endsWith(suffix));

describe('BookingWidget', () => {
  it('books a time from start to finish, and the booking is real', async () => {
    const booked: string[] = [];
    widget({ onBooked: (b) => booked.push(b.booking_id) });

    fireEvent.click(await firstTime());
    // The terms are on screen before anything can be confirmed.
    expect(await screen.findByText(/Held for you until/)).toBeTruthy();
    expect(document.querySelector('[data-ob-part="terms"]')?.textContent).toMatch(/cancel/i);

    fillIn();
    const confirm = screen.getByRole('button', { name: 'Confirm booking' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    expect(await screen.findByText('You are booked')).toBeTruthy();
    const code = document.querySelector('.ob-code')?.textContent;
    expect(code).toBeTruthy();
    // onBooked runs in an effect after the screen changes, so a busy machine can show the text
    // before the callback has run.
    await waitFor(() => expect(booked).toHaveLength(1));

    const sent = posts('/confirm');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ user_confirmed: true, booking_id: booked[0] });

    const real = await server.client.getBooking(booked[0]!, code!);
    expect(real.status).toBe('confirmed');
    expect(real.customer).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
  });

  it('sends nothing without the customer ticking the box', async () => {
    widget();
    fireEvent.click(await firstTime());
    await screen.findByText(/Held for you until/);
    fillIn();
    // Even a form submitted some other way (the Enter key, a script) cannot confirm.
    fireEvent.submit(document.querySelector('form')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(posts('/confirm')).toHaveLength(0);
    expect(screen.queryByText('You are booked')).toBeNull();
  });

  it('retries a confirm that got no answer with the same idempotency key', async () => {
    widget();
    fireEvent.click(await firstTime());
    await screen.findByText(/Held for you until/);
    fillIn();
    fireEvent.click(screen.getByRole('checkbox'));

    server.dropNext('/confirm');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not reach/);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await screen.findByText('You are booked');

    const attempts = posts('/confirm');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.body!.idempotency_key).toBe(attempts[1]!.body!.idempotency_key);
  });

  it('starts over when the hold ran out', async () => {
    widget();
    fireEvent.click(await firstTime());
    await screen.findByText(/Held for you until/);
    fillIn();
    fireEvent.click(screen.getByRole('checkbox'));

    server.clock.advanceSeconds(3600);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    // Back at the list of times, not stuck on a dead form.
    expect(await screen.findByRole('list', { name: 'Free times' })).toBeTruthy();
    expect(screen.queryByText('You are booked')).toBeNull();
  });

  it('lets go of the hold when the customer chooses another time', async () => {
    widget();
    fireEvent.click(await firstTime());
    await screen.findByText(/Held for you until/);
    fireEvent.click(screen.getByRole('button', { name: 'Choose another time' }));
    await screen.findByRole('list', { name: 'Free times' });
    await waitFor(() => expect(posts('/release')).toHaveLength(1));
  });

  it('sends a time that needs an online deposit to the booking page, without holding it', async () => {
    const slot: Slot = {
      slot_id: 'deposit-slot',
      start: '2026-10-16T10:00:00+02:00',
      end: '2026-10-16T11:00:00+02:00',
      offering: { id: 'color', name: 'Colour' },
      resource: null,
      price: { amount: 120000, currency: 'NOK' },
      deposit: {
        amount: { amount: 30000, currency: 'NOK' },
        due: 'at_confirmation',
        description: 'Deposit',
      },
      cancellation_policy: {
        refundability: 'refundable',
        description: 'Free until 24 hours before.',
        free_cancellation_until: null,
        late_cancellation_fee: null,
        no_show_fee: null,
      },
    };
    const held: string[] = [];
    const stub = {
      info: async () => ({
        venue: { name: 'Studio', timezone: 'Europe/Oslo' },
        services: [{ id: 'color', name: 'Colour', price: null }],
        staff: [],
        booking_page: 'https://example.com/b/studio',
      }),
      availability: async () => ({ date: DATE, slots: [slot] }),
      hold: async (input: { slot_id: string }) => {
        held.push(input.slot_id);
        throw new Error('should not hold');
      },
    } as unknown as OpenBookingClient;

    render(<BookingWidget client={stub} date={DATE} />);
    fireEvent.click(await firstTime());
    const link = await screen.findByRole('link', { name: 'Continue on the booking page' });
    expect(link.getAttribute('href')).toBe('https://example.com/b/studio');
    expect(held).toEqual([]);
  });
});
