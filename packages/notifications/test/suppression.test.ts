import { describe, expect, it, vi } from 'vitest';
import { BookingService, ManualClock } from '@openbooking-sh/core';
import { createDemoSalonProvider } from '@openbooking-sh/provider-memory';
import {
  MemoryMailer,
  MemorySuppressionList,
  ResendMailer,
  attachNotifications,
  type NotificationOptions,
} from '../src';
import { describeSuppressionList } from './suppression-contract';

describeSuppressionList('memory', async () => new MemorySuppressionList());

const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };
const LINK = 'https://openbooking.sh/unsubscribe?token=abc';

async function bookAndWait(over: Partial<NotificationOptions> & { unsubscribe?: boolean }) {
  const mailer = new MemoryMailer();
  const clock = new ManualClock('2026-10-06T07:00:00Z');
  const service = new BookingService({ provider: createDemoSalonProvider(), clock });
  const errors: unknown[] = [];
  const { unsubscribe = true, ...rest } = over;
  const notifications = attachNotifications({
    service,
    mailer,
    config: {
      from: 'Studio Nord <bookings@openbooking.sh>',
      ownerEmail: 'owner@studionord.example',
      ...(unsubscribe ? { unsubscribeUrl: () => LINK } : {}),
    },
    onError: (e) => errors.push(e),
    ...rest,
  });
  const { slots } = await service.searchAvailability({
    date: '2026-10-09',
    party_size: { total: 1 },
    offering_id: 'haircut',
    time_from: '15:00',
  });
  const h = await service.hold({
    slot_id: slots[0]!.slot_id,
    idempotency_key: 'hold-0001',
    customer: ada,
  });
  await service.confirm({
    booking_id: h.booking_id,
    idempotency_key: 'confirm-0001',
    user_confirmed: true,
  });
  await notifications.idle();
  return { mailer, errors };
}

describe('unsubscribe in customer emails', () => {
  it('carries RFC 8058 headers and a footer link to the customer only', async () => {
    const { mailer } = await bookAndWait({});
    const toCustomer = mailer.sent.find((m) => m.to === 'ada@example.com')!;
    expect(toCustomer.headers).toEqual({
      'List-Unsubscribe': `<${LINK}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(toCustomer.text).toContain(LINK);
    expect(toCustomer.html).toContain(`href="${LINK}"`);
    // The business manages its own notices in Studio; it gets no unsubscribe link.
    const toOwner = mailer.sent.find((m) => m.to === 'owner@studionord.example')!;
    expect(toOwner.headers).toBeUndefined();
    expect(toOwner.text).not.toContain(LINK);
  });

  it('has no link or headers when none is configured', async () => {
    const { mailer } = await bookAndWait({ unsubscribe: false });
    const toCustomer = mailer.sent.find((m) => m.to === 'ada@example.com')!;
    expect(toCustomer.headers).toBeUndefined();
    expect(toCustomer.text).not.toContain('unsubscribe');
  });

  it('sends nothing to a suppressed customer but still tells the business', async () => {
    const { mailer } = await bookAndWait({ isSuppressed: (e) => e === 'ada@example.com' });
    expect(mailer.sent.map((m) => m.to)).toEqual(['owner@studionord.example']);
  });

  it('fails closed when the suppression check throws', async () => {
    const { mailer, errors } = await bookAndWait({
      isSuppressed: () => Promise.reject(new Error('db down')),
    });
    expect(mailer.sent).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('ResendMailer headers', () => {
  it('passes headers through to the API', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const mailer = new ResendMailer({
      apiKey: 'k',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await mailer.send({
      to: 'a@example.com',
      from: 'x <x@example.com>',
      subject: 's',
      text: 't',
      html: 'h',
      headers: { 'List-Unsubscribe': '<https://x>' },
    });
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.headers).toEqual({ 'List-Unsubscribe': '<https://x>' });
  });
});
