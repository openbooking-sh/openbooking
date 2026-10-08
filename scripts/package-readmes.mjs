// Writes packages/*/README.md (the npm page of each package). Run: node scripts/package-readmes.mjs
import { writeFileSync } from 'node:fs';

const S = '@openbooking-sh';
const footer = `
## Learn more

- [OpenBooking on GitHub](https://github.com/openbooking-sh/openbooking): the full SDK, docs and examples
- [openbooking.sh](https://openbooking.sh)

Apache-2.0
`;

const pkgs = {
  core: {
    title: 'The booking engine',
    intro:
      'The domain model, the `BookingProvider` interface every booking system implements, and `BookingService`: the agent-safe engine that every protocol adapter runs through. It enforces holds that expire, idempotent retries, explicit customer consent, and cancellation and deposit terms shown before anything is confirmed.',
    usage: `import { BookingService } from '${S}/core';

const service = new BookingService({ provider: myProvider });

const { slots } = await service.searchAvailability({ date: '2026-10-09', party_size: { total: 1 } });
const hold = await service.hold({ slot_id: slots[0].slot_id, idempotency_key: crypto.randomUUID() });
const booking = await service.confirm({
  booking_id: hold.booking_id,
  idempotency_key: crypto.randomUUID(),
  user_confirmed: true, // only after the customer said yes to time, price and terms
  customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
});`,
    more: 'Implement `BookingProvider` (`listVenues`, `searchAvailability`, `createHold`, `confirmHold`, `getBooking`, `cancelBooking`) to make any booking system bookable by AI agents.',
  },
  server: {
    title: 'One app for every agent protocol',
    intro:
      'Mounts a `BookingProvider` on one web-standard app (Hono): MCP for Claude and ChatGPT, UCP, an A2A Agent Card, a public booking page with WebMCP, and OpenBooking Studio. Runs on Node, Vercel, Cloudflare, Deno and Bun.',
    usage: `import { createOpenBookingApp, listen } from '${S}/server';
import { createDemoSalonProvider } from '${S}/provider-memory';

const { app } = createOpenBookingApp({
  provider: createDemoSalonProvider(), // or your own BookingProvider
  baseUrl: 'https://book.example.com',
});

await listen(app, { port: 3000 });
// MCP at /mcp · booking page at /book · Studio at /studio · UCP at /.well-known/ucp`,
  },
  'adapter-mcp': {
    title: 'MCP server for booking',
    intro:
      'Seven booking tools for any MCP client (Claude, ChatGPT, Cursor and more): `get_business_info`, `search_availability`, `hold_slot`, `confirm_booking`, `get_booking`, `reschedule_booking` and `cancel_booking`. Served over Streamable HTTP or stdio.',
    usage: `import { createMcpHttpHandler } from '${S}/adapter-mcp';

const mcp = createMcpHttpHandler({ service }); // service: a BookingService from ${S}/core
// Web-standard handler: return mcp.fetch(request) from any route, e.g. /mcp`,
    more:
      'Most apps use this through `' + S + '/server`, which mounts it with host and origin checks.',
  },
  'adapter-ucp': {
    title: 'Universal Commerce Protocol (draft)',
    intro:
      'Exposes a `BookingService` over the Universal Commerce Protocol: the business profile at `/.well-known/ucp`, booking sessions over REST and an availability extension. UCP booking support follows a draft and may change with the spec.',
    usage: `import { createUcpRouter, buildUcpProfile } from '${S}/adapter-ucp';

app.route('/ucp', createUcpRouter({ service, baseUrl, ucpPath: '/ucp' }));
app.get('/.well-known/ucp', (c) => c.json(buildUcpProfile({ baseUrl, ucpPath: '/ucp' })));`,
  },
  'adapter-a2a': {
    title: 'A2A Agent Card',
    intro:
      'An Agent2Agent (A2A) Agent Card plus a `SendMessage` JSON-RPC endpoint that lets A2A agents search availability, hold, confirm and cancel bookings with the same safety guarantees as MCP. Most apps use it through `' +
      S +
      '/server`.',
    usage: `import { buildAgentCard, AGENT_CARD_PATH } from '${S}/adapter-a2a';`,
  },
  'booking-page': {
    title: 'Public booking page, embed and WebMCP',
    intro:
      'A server-rendered booking page with schema.org data and pre-fill links, a manage-booking page, and `embed.js`: one line that adds a Book button, a booking popup and WebMCP booking tools to any website.',
    usage: `import { createBookingPage } from '${S}/booking-page';

const page = createBookingPage({
  service,
  pageUrl: 'https://book.example.com/book',
  apiBase: 'https://book.example.com/book',
});
app.route('/book', page.app);

// On any website:
// <script src="https://book.example.com/book/embed.js" async></script>`,
  },
  studio: {
    title: 'OpenBooking Studio',
    intro:
      'The dashboard for the people running the business: calendar per staff member, bookings, customers, services, settings, insights, and a log of every AI agent call. Mount it on any Hono app; protect it with a token.',
    usage: `import { createStudio } from '${S}/studio';

const studio = createStudio({ service, token: process.env.STUDIO_TOKEN });
app.route('/studio', studio.app);`,
  },
  'provider-memory': {
    title: 'Configured booking provider',
    intro:
      'A `BookingProvider` driven by a plain config: venues, staff or tables, services, opening hours, buffers, deposits and cancellation rules. Bookings go to a pluggable store: memory by default, Postgres via `' +
      S +
      '/postgres`. Includes a demo salon and a demo restaurant.',
    usage: `import { createDemoSalonProvider, MemoryBookingProvider } from '${S}/provider-memory';

const provider = createDemoSalonProvider();
// or: new MemoryBookingProvider(myConfig, { store: postgresStores(db).bookings })`,
  },
  postgres: {
    title: 'Postgres storage',
    intro:
      'Durable stores for everything OpenBooking keeps: bookings and holds (with a per-resource lock so two servers can never sell the same time), idempotency records, Studio activity, Cal.com records, and the hosted account, calendar, email and rate-limit stores. Works with `pg` pools and PGlite.',
    usage: `import { connectPostgres, migrate, postgresStores } from '${S}/postgres';

const db = connectPostgres(process.env.DATABASE_URL!);
await migrate(db); // idempotent; safe on every start
const stores = postgresStores(db);
// stores.bookings, stores.idempotency, stores.activity, stores.calcom, ...`,
  },
  'provider-calcom': {
    title: 'Cal.com connector (beta)',
    intro:
      'A `BookingProvider` for Cal.com (hosted) and self-hosted Cal.com, via the Cal.com API v2. Makes an existing Cal.com account bookable by AI agents with holds, consent and cancellation terms.',
    usage: `import { CalcomBookingProvider } from '${S}/provider-calcom';

const provider = new CalcomBookingProvider({
  apiKey: process.env.CAL_API_KEY!,
  venue: { id: 'venue', name: 'Studio Nord', timezone: 'Europe/Oslo', currency: 'NOK' },
});`,
  },
  conformance: {
    title: 'Conformance suite for booking providers',
    intro:
      'Vitest checks that a `BookingProvider` keeps the promises the engine relies on: slots are never overbooked (even with parallel holds), expired holds stop blocking, cancellations free the place, and every failure is a `BookingError` with the right code. Optional methods (`updateBooking`, `rescheduleBooking`, `listBookings`) are tested only when implemented.',
    usage: `import { describeProviderConformance } from '@openbooking-sh/conformance/vitest';

describeProviderConformance('MySystemProvider', {
  create: () => new MySystemProvider(testConfig), // a fresh, empty provider per test
  now: new Date('2030-06-03T08:00:00Z'), // before the date you search
  query: { date: '2030-06-04', party_size: { total: 1 } }, // must return open slots
});`,
    more: 'Also exports `runProviderConformance(options)`, which returns a pass/fail result per check without a test runner.',
  },
  notifications: {
    title: 'Booking emails with calendar invites',
    intro:
      'Confirmation and cancellation emails for customers (with an `.ics` invite) and new-booking notices for the business. Sends through Resend or any `Mailer`, deduplicated so agent retries never email twice.',
    usage: `import { attachNotifications, ResendMailer } from '${S}/notifications';

attachNotifications({
  service,
  mailer: new ResendMailer({ apiKey: process.env.RESEND_API_KEY! }),
  config: { from: 'Studio Nord <bookings@example.com>', ownerEmail: 'owner@example.com' },
});`,
  },
  'google-calendar': {
    title: 'Google Calendar sync',
    intro:
      'OAuth for Google Calendar, busy times that block availability, and bookings written to the calendar as events (updated and deleted with the booking).',
    usage: `import { googleAuthUrl, exchangeCode, attachCalendarSync, googleBusySource } from '${S}/google-calendar';`,
    more: 'See `' + S + '/hosted` for a complete wiring.',
  },
  hosted: {
    title: 'Hosted, multi-business OpenBooking',
    intro:
      'Everything behind app.openbooking.sh: sign-up and a self-serve setup wizard (with website import), Studio per business, booking pages, one MCP app that finds and books any listed business (`find_business`), password reset, email confirmation, rate limits, Google Calendar, emails, analytics and Slack notifications.',
    usage: `import { createHostedApp } from '${S}/hosted';

const hosted = createHostedApp({
  baseUrl: 'https://app.example.com',
  sessionSecret: process.env.SESSION_SECRET!,
  // plus Postgres stores, mail, google, analytics, ops: see the docs
});
// hosted.app is a web-standard app; serve it anywhere`,
  },
};

for (const [dir, p] of Object.entries(pkgs)) {
  const md = `# ${S}/${dir}

**${p.title}.** ${p.intro}

Part of [OpenBooking](https://openbooking.sh): open-source booking that every AI assistant can use.

\`\`\`sh
npm install ${S}/${dir}
\`\`\`

## Usage

\`\`\`ts
${p.usage}
\`\`\`
${p.more ? `\n${p.more}\n` : ''}${footer}`;
  writeFileSync(new URL(`../packages/${dir}/README.md`, import.meta.url), md);
}
console.log('wrote', Object.keys(pkgs).length, 'READMEs');
