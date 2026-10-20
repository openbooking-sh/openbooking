import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ManualClock } from '@openbooking-sh/core';
import { MemoryMailer, MemorySuppressionList } from '@openbooking-sh/notifications';
import { createHostedApp, createSigner } from '../src';

const BASE = 'http://localhost:3000';
const SECRET = 'test-secret-0123456789';
// Tuesday 6 October 2026, 09:00 in Oslo.
const NOW = '2026-10-06T07:00:00Z';
const ada = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup(extra: Record<string, unknown> = {}) {
  const mailer = new MemoryMailer();
  const hosted = createHostedApp({
    baseUrl: BASE,
    sessionSecret: SECRET,
    clock: new ManualClock(NOW),
    mail: { mailer, from: 'bookings@openbooking.sh' },
    ...extra,
  });
  cleanups.push(hosted.close);
  const request = (path: string, init: RequestInit = {}) =>
    hosted.app.request(`${BASE}${path}`, init);
  const signup = async (name: string, email: string) => {
    const res = await request('/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        business_name: name,
        your_name: 'Owner',
        email,
        password: 'correct horse',
        category: 'hair_salon',
        city: 'Oslo',
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { business_id: string }).business_id;
  };
  /** Book through the business's own MCP endpoint, like an assistant would. */
  const book = async (businessId: string, day: string, customer = ada) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/b/${businessId}/mcp`), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('host', new URL(url).host);
        return hosted.app.fetch(new Request(url, { ...init, headers }));
      },
    });
    const client = new Client(
      { name: 'claude-ai', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;
    const search = await call('search_availability', {
      date: day,
      party_size: 1,
      offering_id: 'haircut',
    });
    const hold = await call('hold_slot', {
      slot_id: search.slots[0].slot_id,
      idempotency_key: randomUUID(),
      customer,
    });
    const confirmed = await call('confirm_booking', {
      booking_id: hold.booking_id,
      idempotency_key: randomUUID(),
      user_confirmed: true,
    });
    expect(confirmed.status).toBe('confirmed');
    await hosted.idle();
  };
  const mailTo = (email: string) => mailer.sent.filter((m) => m.to === email);
  return { hosted, mailer, request, signup, book, mailTo };
}

const linkOf = (mail: { text: string }) =>
  new URL(/https?:\/\/\S*\/unsubscribe\?token=\S+/.exec(mail.text)![0]);
const post = (request: ReturnType<typeof setup>['request'], url: URL, body?: string) =>
  request(url.pathname + url.search, {
    method: 'POST',
    ...(body ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body } : {}),
  });

describe('unsubscribe (hosted, end to end)', () => {
  it('books, finds the link in the real email, GET changes nothing, POST stops later emails', async () => {
    const { request, signup, book, mailTo } = setup();
    const id = await signup('Studio Nord', 'maria@example.com');
    await book(id, '2026-10-08');

    const first = mailTo('ada@example.com');
    expect(first).toHaveLength(1);
    const link = linkOf(first[0]!);
    // RFC 8058: the header carries the same link and asks for a one-click POST.
    expect(first[0]!.headers).toEqual({
      'List-Unsubscribe': `<${link.href}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(first[0]!.html).toContain('Unsubscribe</a>');
    // The token holds no readable personal data.
    expect(link.href).not.toContain('ada');
    expect(link.href).not.toContain('Lovelace');
    expect(
      Buffer.from(link.searchParams.get('token')!.split('.')[0]!, 'base64url').toString(),
    ).not.toContain('ada');

    // A mail scanner opening the link must not unsubscribe anyone.
    const page = await request(link.pathname + link.search);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain('Studio Nord');
    expect(html).not.toContain('ada@example.com');
    expect(page.headers.get('cache-control')).toBe('no-store');
    await book(id, '2026-10-09');
    expect(mailTo('ada@example.com')).toHaveLength(2);

    const done = await post(request, link);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('unsubscribed');

    // Booking again now sends the customer nothing; the business is still told.
    await book(id, '2026-10-12');
    expect(mailTo('ada@example.com')).toHaveLength(2);
    expect(
      mailTo('maria@example.com').filter((m) => m.subject.startsWith('New booking')),
    ).toHaveLength(3);

    // Repeating is harmless.
    expect((await post(request, link)).status).toBe(200);
    // The address is matched ignoring case, a different customer is unaffected.
    await book(id, '2026-10-13', { ...ada, email: 'ADA@Example.com' });
    expect(mailTo('ADA@Example.com')).toHaveLength(0);
    await book(id, '2026-10-14', { ...ada, email: 'grace@example.com' });
    expect(mailTo('grace@example.com')).toHaveLength(1);
  });

  it('accepts the one-click POST a mail client sends, without opening the page', async () => {
    const { request, signup, book, mailTo } = setup();
    const id = await signup('Studio Nord', 'maria@example.com');
    await book(id, '2026-10-08');
    const header = mailTo('ada@example.com')[0]!.headers!['List-Unsubscribe']!;
    const url = new URL(header.slice(1, -1));
    const res = await post(request, url, 'List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    await book(id, '2026-10-09');
    expect(mailTo('ada@example.com')).toHaveLength(1);
  });

  it('rejects tampered, foreign-purpose and unknown tokens, and changes nothing', async () => {
    const { request, signup, book, mailTo } = setup();
    const id = await signup('Studio Nord', 'maria@example.com');
    await book(id, '2026-10-08');
    const link = linkOf(mailTo('ada@example.com')[0]!);
    const token = link.searchParams.get('token')!;

    const swapped = `${Buffer.from('bart-barbers.' + 'a'.repeat(64)).toString('base64url')}.${token.split('.').slice(1).join('.')}`;
    const signer = createSigner(SECRET, () => Date.parse(NOW));
    const bad = [
      token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'),
      swapped,
      '',
      'garbage',
      // Right secret, wrong purpose (an owner session token is not an unsubscribe link).
      signer.sign('session', `${id}.${'a'.repeat(64)}`, 60_000),
      // Right everything, but expired.
      createSigner(SECRET, () => Date.parse(NOW) - 10 * 365 * 24 * 3_600_000).sign(
        'unsubscribe',
        `${id}.${'a'.repeat(64)}`,
        1000,
      ),
      // Signed by someone with another secret.
      createSigner('another-secret-0123456789').sign(
        'unsubscribe',
        `${id}.${'a'.repeat(64)}`,
        60_000,
      ),
      // A valid signature for a business that does not exist.
      signer.sign('unsubscribe', `ghost.${'a'.repeat(64)}`, 60_000),
    ];
    for (const t of bad) {
      const url = `/unsubscribe?token=${encodeURIComponent(t)}`;
      expect((await request(url)).status).toBe(400);
      const res = await request(url, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('unsubscribed');
    }
    await book(id, '2026-10-09');
    expect(mailTo('ada@example.com')).toHaveLength(2);
  });

  it('keeps businesses apart: a link works only for the business that sent it', async () => {
    const { request, signup, book, mailTo } = setup();
    const nord = await signup('Studio Nord', 'maria@example.com');
    const west = await signup('Studio Vest', 'vera@example.com');
    await book(nord, '2026-10-08');
    await book(west, '2026-10-08');
    const nordLink = linkOf(mailTo('ada@example.com')[0]!);
    expect((await post(request, nordLink)).status).toBe(200);

    await book(nord, '2026-10-09');
    expect(mailTo('ada@example.com')).toHaveLength(2); // only Vest's, from before
    await book(west, '2026-10-09');
    expect(mailTo('ada@example.com')).toHaveLength(3); // Vest still emails her
    const [, vestLink] = [0, linkOf(mailTo('ada@example.com')[2]!)];
    expect(vestLink.href).not.toBe(nordLink.href);
  });

  it('shares suppressions through the configured store, so a restart or another instance honours them', async () => {
    const suppressions = new MemorySuppressionList();
    const a = setup({ suppressions });
    const id = await a.signup('Studio Nord', 'maria@example.com');
    await a.book(id, '2026-10-08');
    await post(a.request, linkOf(a.mailTo('ada@example.com')[0]!));
    await a.hosted.close();

    // Same business record and store, new app: still suppressed (stores are shared in production).
    const b = setup({ suppressions, businesses: a.hosted.businesses });
    await b.book(id, '2026-10-09');
    expect(b.mailTo('ada@example.com')).toHaveLength(0);
  });
});
