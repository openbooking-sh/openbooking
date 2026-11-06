# Hosted OpenBooking

Many businesses on one deployment (`@openbooking-sh/hosted`): sign-up and Studio settings, Google
Calendar sync, confirmation emails, one OpenBooking app across every business, and a public booking
page per business.

```sh
pnpm dev:hosted     # seeds "Studio Nord"; Studio login demo@openbooking.sh / openbooking-demo
```

## Routes

| Path                                                          | What                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /signup`, `POST /api/signup`, `POST /api/login`          | Owner accounts (email + password, scrypt; 7-day signed session token, revoked by logout or a password reset)           |
| `GET /studio`, `/studio/api/*`                                | Studio for the logged-in business, including **Settings**                                                              |
| `ALL /mcp`                                                    | **The OpenBooking app**: `find_business` plus the seven booking tools, each taking `business_id`                       |
| `/b/{id}`                                                     | The business: booking page for browsers, JSON index otherwise                                                          |
| `/b/{id}/mcp`, `/b/{id}/ucp/*`, `/b/{id}/.well-known/*`       | Per-business MCP, UCP and A2A card (same as a self-hosted single business)                                             |
| `/b/{id}/book/*`                                              | Booking page API, manage links (`/book/manage/{booking}?code=`), confirm links (`/book/confirm/{booking}`), `llms.txt` |
| `/b/{id}/usp/*`, `/b/{id}/.well-known/usp`                    | USP, when the owner turned it on (see below)                                                                           |
| `GET /b/{id}/embed.js`                                        | The website snippet (see below)                                                                                        |
| `GET /reset`, `POST /api/password/*`, `GET /api/verify-email` | Password reset and email confirmation                                                                                  |
| `GET /oauth/google/callback`                                  | Google Calendar connection                                                                                             |

`{id}` is the business's URL name (`studio-nord`), fixed at sign-up, and is also its
`business_id` and the venue id on its bookings.

## Self-serve setup

Sign-up asks for the business name, type, city, owner name, email and password, and creates a
business that is bookable straight away: the owner as the only staff member, typical services for
the type (example NOK prices), weekday hours, and free cancellation until 24 hours before.

The owner then lands on **`/setup`**, one short screen per step, each saved as they go:

1. **Import from your website** (optional): `POST /studio/api/import` reads their site and proposes
   address, phone, opening hours and services. Sources: schema.org JSON-LD, page meta and `tel:`
   links, and, when `ANTHROPIC_API_KEY` is set, Claude reading the home page plus up to two
   likely prices pages. Only public http(s) addresses are fetched (every redirect re-checked),
   with an 8-second timeout and a 1.5 MB cap; 10 imports per business per hour.
2. **Contact:** street, postal code, city, phone, one line about the business.
3. **Services:** name, minutes, price; add and remove rows.
4. **Opening hours:** one-tap presets, then any day adjusted.
5. **Team:** names ("just me" is fine).
6. **Live:** "Try it yourself" in ChatGPT and Claude, the booking page link, the Google step and
   the website snippet.

Everything stays editable in Studio **Settings**, which also has the checklist and links.

Settings are in owner terms (`BusinessSettingsSchema` in `@openbooking-sh/studio`): profile, opening
hours per weekday, closed dates, staff, services (duration, price, who does it), one cancellation
rule as percentages of the price, booking rules, email preferences, and whether the business is
listed in the OpenBooking app. `catalog.ts` turns them into the provider configuration.

Deposits are set per business once it connects its own Stripe account: see
[Deposits (Stripe)](#deposits-stripe) below.

## Getting found: Google, website, social

Studio Settings has a **Get found on Google and your website** card with copy buttons:

1. **Google Business Profile:** paste the booking page link under Bookings, so a Book button shows
   in Google Search and Maps.
2. **Website:** one line, pasted once (Wix custom code, Squarespace code injection, WordPress via
   WPCode, Webflow footer code, Shopify `theme.liquid`):

   ```html
   <script src="https://app.openbooking.sh/b/studio-nord/embed.js" async></script>
   ```

   It adds a floating Book button and a booking popup, turns existing links to the booking page
   (and elements with `data-openbooking`) into popup triggers, adds schema.org `LocalBusiness` data
   with the services, and registers the booking tools for browser agents (WebMCP) on the
   business's own site. Options on the tag: `data-label`, `data-color`, `data-position="left"`,
   `data-button="none"`, `data-structured-data="off"`, `data-agents="off"`. The booking page API
   allows any origin (CORS) for this; no cookies are involved.

3. **Instagram and Facebook:** the booking page link in the bio and the Book now button.

The schema.org block is added by script, which Google reads; crawlers that don't run JavaScript
see the booking page's own server-rendered data instead.

## Google Calendar

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (a Google Cloud OAuth web client with the Calendar
API enabled, redirect URI `{BASE_URL}/oauth/google/callback`). Scopes: `openid email`,
`calendar.events`, `calendar.freebusy`, `calendar.calendarlist.readonly`. Google requires app
verification for these scopes before outside users can connect without warnings; plan for that.

- **Busy time blocks availability.** Each staff member maps to a calendar (default: the owner's
  primary). Events there hide those times from search and refuse holds. OpenBooking's own events,
  free (transparent), cancelled and declined events don't count. All-day events block the day.
- **Bookings become events** (on confirm) and are deleted on cancel.
- **Failures.** Google down → bookings fail with a retryable error (we can't promise the time is
  free). Access revoked → Studio shows "reconnect", and bookings continue without Google.

## Deposits (Stripe)

Each business connects **its own** Stripe account in Studio → Settings → Online payments: paste a
restricted key that may write Checkout Sessions and Refunds (or a secret key). Money goes straight
to the owner, not through OpenBooking. The key is checked with Stripe before it is saved, and Studio
only ever shows its last four characters.

- **Deposit.** The owner sets a percentage of the service price (0 = none). A service has a deposit
  only while Stripe is connected and it has a price.
- **Booking page.** The button says "Pay {amount} deposit", and the lines under it say what the
  deposit is and what becomes of it if the customer cancels (free until when, and what is kept
  after). It sends the customer to Stripe Checkout; Stripe returns them to the page with the
  session id, and the page confirms the booking. The engine asks Stripe whether that session was
  paid, for this booking and this amount, so a made-up token never works.
- **Confirmation email.** After a paid booking the customer's email says what was paid, repeats
  the cancellation policy, and says what happens to the deposit if they cancel. It reads the same
  fields the refund does, so the email and the refund agree.
- **Cancelling.** The email links to the manage page, which says what cancelling costs right now
  before anything is pressed. While it is free, one press cancels and refunds. When a fee applies,
  or the free time ran out after the page was opened, the page asks once more before it charges.
- **Agents** get `payment_required` with `payment_url` and `payment_token` (see
  [RECIPES](RECIPES.md)).
- **Refunds** follow the cancellation rules and run automatically. If Stripe is down the booking is
  still cancelled and the call answers `refund_failed`; cancelling again retries safely. A late
  cancellation refunds the deposit minus the fee (a partial refund). Before it refunds, OpenBooking
  asks Stripe what has already been refunded on that payment (including refunds the owner made in
  the Stripe dashboard) and sends only the difference, so a retry never pays twice, even after
  Stripe has forgotten the idempotency key (it does after 24 hours). If it cannot read the refunds
  already made, it refunds nothing and answers `refund_failed` rather than guess. This needs the
  key to be able to read Refunds as well as write them.
- **Customers who never come back.** Connecting the key also registers a webhook at
  `/b/{id}/stripe/webhook` (the key needs the Webhook Endpoints permission; Studio says when it
  could not). The signature is checked, and a payment for a hold that has since expired or been
  released is refunded in full. While the hold is still live the webhook answers 503, so Stripe
  delivers it again later. Duplicate or out-of-order deliveries never refund twice. Events for
  payments that did not happen (failed, expired, or a delayed payment not yet received) are
  acknowledged and ignored.
- **A checkout nobody pays.** The customer pays nothing and the hold simply runs out, so the slot is
  free again. The Stripe payment page itself stays open for up to 24 hours; a payment made on it
  after the hold ran out is refunded as above.
- **What the owner sees.** The booking drawer in Studio has a Payment line: waiting for payment,
  not paid, paid online or in person, and for a cancelled booking the refund the terms gave and what
  was kept. It says what is due, not that the money has arrived: check the payment in Stripe when
  in doubt. A deposit taken in person is never refunded by Stripe, so the owner hands it back.
- **Staff in Studio** record a deposit taken in person without Stripe.
- **Disconnecting** Stripe stops new deposits. Deposits already paid can then no longer be refunded
  automatically.

The Stripe key sits in the business record as-is, like the Google tokens (not exported, not shown).

## Assistants booking through USP

USP is a draft standard from Wix and Stripe that lets any assistant or platform discover and book a
business, signing in with a key it makes itself (no accounts). It is **off** for every business until the
owner turns it on in Studio → Settings → AI assistants, where they also choose how bookings happen:

- **The customer confirms on a page** (recommended): the assistant holds a time and gets a link to
  `/b/{id}/book/confirm/{booking}`. The customer sees the time, price and cancellation terms and
  confirms there; nothing is booked before.
- **The assistant books immediately:** its request confirms the booking, trusting that it asked the
  customer first.

The business's profile is at `/b/{id}/.well-known/usp` (there is no profile at the root, because
the root is not one business). USP's MCP binding (`/b/{id}/usp/mcp`, the `usp_*` tools) is off
unless the deployment passes `uspMcp: true`; it then serves every business that has USP on, with the
same consent setting. Businesses saved before the setting existed have no `assistants`
block and count as off. For several instances or serverless, pass `uspState` (`postgresStores(db).usp`,
which the Vercel entry does when `DATABASE_URL` is set): it holds owners, credentials and replay
protection, shared by every instance and kept apart per business. When a platform calls, hosted fetches the platform's own profile (public internet only, cached, shared by all businesses) and uses only what both sides support. Protocol details are in
[SPEC-NOTES.md](SPEC-NOTES.md#6-usp-universal-scheduling-protocol-draft).

## API keys for the business's own website

A site with no backend (an AI-built static page, say) can call its business's booking API straight
from the browser or from a function. In Studio → Settings → API keys the owner makes a key and gives it
a name and one of two scopes:

- **Read availability:** `GET /b/{id}/book/api/info`, `/availability` and `/openapi.json`.
- **Read and book:** also holds, confirming, cancelling and reading a hold or booking
  (`/b/{id}/book/api/*`), and the business's MCP endpoint (`/b/{id}/mcp`).

Send it as `x-openbooking-key: obk_…` or as `Authorization: Bearer obk_…`. A key works for its own
business only. The secret is shown once; only a hash is stored. Studio lists each key with when it was last
used and revokes it on its own, and each key is limited to 300 calls a minute. A bad, revoked or
other business's key gets `401 invalid_api_key`, and a read key asked to book gets
`403 insufficient_scope`. A business holds at most ten active keys, and closing the account deletes them.

**A key is not a lock.** Public access still works without one, as before, so a visitor (or a scraper)
can call the same endpoints with no key. What a key adds is a name for who is calling, a way to give a
site read-only access, a limit per site, and a way to cut one site off. A key in a browser's JavaScript is
visible to anyone who opens the page, so give a site that only shows availability a read key. UCP,
A2A and USP are not governed by keys. Studio never accepts one.

## Emails

Set `RESEND_API_KEY` (and `MAIL_FROM`, default `bookings@openbooking.sh`, which must be a verified
Resend domain). Without it nothing is sent (`pnpm dev:hosted` prints them instead).

- Customer: confirmation with an `.ics` invite and a manage link; cancellation with `METHOD:CANCEL`.
- Owner: new and cancelled bookings, except ones staff made in Studio.
- Deduplicated per booking, so agent retries never send twice.

## Owner accounts

- **Password reset:** `/reset` emails a link that works once (it is tied to the current password
  hash) and expires in an hour. Saving a new password logs out every other session.
- **Log out** ends every session of the account, not just that browser, so a copied token stops
  working at once. Tokens last a week.
- **Email confirmation:** sign-up sends a confirmation link. With email enabled, a business is
  listed in the OpenBooking app (`find_business`) only after the owner confirmed it; its booking
  page and per-business MCP work straight away. Studio shows a "Confirm your email" step.
- **Unsubscribe:** every customer email has an unsubscribe link and `List-Unsubscribe` /
  `List-Unsubscribe-Post` headers (RFC 8058 one-click). The link is a signed token naming the
  business and a SHA-256 of the normalised address (no address in it). `GET /unsubscribe` only shows
  a button, so mail scanners change nothing; the POST (also what a mail client's one-click sends)
  records the hash for that business. After that the address gets no emails from that business at
  all, confirmations and cancellations included, and the business is still told about bookings. The
  list is per business, keeps no address, and is deleted with the account. The business's own
  notices have no link: they are switched off in Studio.
- **Rate limits** (`LIMITS` in `limits.ts`): login per email and per IP, sign-up per IP (and 100 an
  hour across all addresses), reset emails per email and IP, holds per IP and business. The IP
  comes from `x-real-ip` / `x-forwarded-for`, which Vercel sets; pass `clientIp` when running
  without a proxy. See [Abuse and capacity](#abuse-and-capacity) for what is and is not limited.

## Storage

Everything stateful sits behind an interface with an in-memory default, and `@openbooking-sh/postgres`
implements all of them. `postgresStores(db)` returns them ready to pass to `createHostedApp`:

| Option            | Interface             | Postgres                    | Notes                                                        |
| ----------------- | --------------------- | --------------------------- | ------------------------------------------------------------ |
| `businesses`      | `BusinessStore`       | `PostgresBusinessStore`     | JSON record; unique id and lower-cased owner email.          |
| `bookings`        | `BookingRecordStore`  | `PostgresBookingStore`      | One store for all businesses (venue id = business id).       |
| `idempotency`     | `IdempotencyStore`    | `PostgresIdempotencyStore`  | Shared; hosted prefixes keys with the business id.           |
| `activityFor`     | `(id) => ActivityLog` | `PostgresActivityLog`       | One `scope` per business.                                    |
| `notificationLog` | `NotificationLog`     | `PostgresNotificationLog`   | Insert-if-absent, so no email goes out twice.                |
| `suppressions`    | `SuppressionList`     | `PostgresSuppressionList`   | Unsubscribed addresses as hashes, per business.              |
| `apiKeys`         | `ApiKeyStore`         | `PostgresApiKeyStore`       | Website API keys as hashes, per business.                    |
| `calendarLinks`   | `CalendarLinkStore`   | `PostgresCalendarLinkStore` | Booking id → Google event.                                   |
| `rateLimiter`     | `RateLimiter`         | `PostgresRateLimiter`       | Fixed windows shared by every instance.                      |
| `uspState`        | `UspStateStore`       | `PostgresUspState`          | USP owners, credentials, replay memory; scoped per business. |

With `DATABASE_URL` set, the Vercel entry (`OPENBOOKING_MODE=hosted`) and `pnpm dev:hosted` use all
of them and create the tables on start.
Google refresh tokens are stored in the business record as-is; encrypt them at rest in that store.

## Customer data

A customer can ask the business what it holds about them, or to delete it. The owner does it in
Studio, under **Settings, Customer data**: enter the customer's email address or phone number, then
download their data (a JSON file of their bookings) or delete it. Deleting removes the name,
contact details and notes from their bookings. The bookings themselves (time, service, status)
stay, so the calendar history and statistics remain right. Phone numbers match on their digits,
email addresses ignore case.

- **Upcoming bookings are kept.** A held or confirmed booking that has not ended yet is counted but
  not touched, so the business still knows who is coming. Cancel it first to erase it too.
- **Retention.** Customer data is removed from every booking that ended more than
  `retentionDays` ago (default 730). `GET /api/maintenance/purge` applies it; `vercel.json`
  runs it daily. It needs `CRON_SECRET` set (Vercel sends it as a bearer token) and does not exist
  without it.
- **Lapsed holds.** Nobody runs a job when a hold expires, so `booking.expired` is sent when
  something notices. The same daily purge now sweeps every business for lapsed holds, and
  `GET /api/maintenance/sweep` (same secret) does only that, for a more frequent cron. Vercel Hobby
  allows daily crons only; add a minute-level cron on Pro, or call the endpoint from any scheduler.
- **What this does not reach.** Events already written to the owner's Google Calendar, emails
  already sent, and anything a webhook already delivered to an integrator are outside OpenBooking's
  storage. The owner has to remove those themselves.
- **Self-hosted servers** can offer the same by passing `dataRights` to `createStudio`; the
  stores' `anonymize()` does the work.

### The owner's own data

Under **Settings, Your account** the owner can download everything stored about the business
(account, settings and every booking, as JSON; never the password hash or Google tokens) and close
the account. Closing asks for the password and deletes, in this order: calendar links, activity and
booked-via attribution, idempotency records, all bookings, and last the account itself, so a failure
half way leaves an account the owner can still log into and retry. The booking page stops working
and the id is free to register again.

- Upcoming bookings are not cancelled and customers are not told. The owner should cancel or move
  them first.
- The Google connection stays authorized in the owner's Google account until they remove it at
  myaccount.google.com/permissions; events already in their calendar are theirs and stay.
- Expired rate-limit windows (keyed by IP address) are deleted by the same daily purge.
- A store that lacks `BookingRecordStore.deleteVenue` or `BusinessStore.delete` makes closing
  refuse with 501 before anything is touched.

## Observability

All optional, set as environment variables on the Vercel project:

| Variable                      | Tool                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                  | Sentry (EU region)            | Server errors plus anything logged with `console.error` (failed emails, calendar syncs). No IPs, cookies or request bodies.                                                                                                                                                                                                                                                                                                                                          |
| `POSTHOG_KEY`, `POSTHOG_HOST` | PostHog (EU cloud by default) | Server events keyed by business id: `business_signed_up`, `email_verified`, `website_imported`, `google_calendar_connected`, `password_reset`, `slot_held`, `booking_confirmed` and `booking_cancelled` with their channel. Plus a cookieless browser snippet on owner pages (sign-up, setup, Studio), never on customer booking pages or the password reset page. It counts page views only: no autocapture, heatmaps or session recording, and all text is masked. |
| `SLACK_WEBHOOK_URL`           | Slack incoming webhook        | Operator notifications: new business, email confirmed, Google connected, every booking and cancellation with its channel, server errors (at most one a minute). Business names only. Previews prefix `[preview]`.                                                                                                                                                                                                                                                    |

No customer names, emails or phone numbers are sent to any of them. Background work (emails,
calendar sync, analytics, Slack) finishes after the response through `waitUntil(hosted.idle())`.

## Cold starts

Each new function instance logs one line, with stage names and milliseconds only:

```
[openbooking] cold start: imports=1900ms db_connect=850ms migrate=12ms app=6ms boot=870ms
```

- `imports`: process start until the entry module finished loading (Node start, bundle load; the
  largest single dependency is `@sentry/node`).
- `db_connect`: opening the first Postgres connection: TCP, TLS, login, and a Neon compute waking
  from idle. This is the stage to check first when a cold start takes seconds.
- `migrate`: the schema check. An up-to-date database costs one query; only a database with
  pending migrations takes the advisory lock, so instances booting together still serialise.
- `app`: building the hosted app (stores, routes). Tenants are built lazily per request.

Measured locally (PGlite, so no network): `app` is 2 to 5 ms, the up-to-date `migrate` is one query,
and module loading dominates (Sentry alone is about 1 to 3 seconds on a loaded laptop). A real cold
start adds what only production shows: Neon waking a suspended compute (typically a few hundred
milliseconds up to a couple of seconds) and the round trips between the function and the database.

Settings that matter, none of them code:

- Keep the Vercel function region (`regions` in `vercel.json`, now `fra1`) in the same region as
  the Neon project, otherwise every query pays a transatlantic round trip.
- Use Neon's pooled connection string (`-pooler` host) for `DATABASE_URL`.
- Turn off Neon's scale-to-zero for the production compute (or lengthen the suspend delay), so the
  first request after a quiet period does not wait for the compute to start.

## Abuse and capacity

An audit of what a stranger on the internet can do, and what happens when the free plans run out
(OPE-89). What the code does is checked against the code; the plan limits are not, so read the
numbers in your own Neon and Vercel dashboards.

**Limited in code**

- **Sign-up, login, password reset, unsubscribe:** per IP, plus per email where there is one, and a
  100-an-hour cap on sign-ups across all addresses (each sign-up sends an email). It is counted
  only after the per-IP check, so one noisy address cannot use it up for everybody.
- **Holds:** 20 per IP, per business, per 10 minutes. The count lives in the same limiter as the
  account limits (Postgres in production), so it survives cold starts and is the same on every
  instance. Before this it lived in each process and reset on every cold start.
- **Request size:** every request body is capped at 256 KB (`maxBodyBytes`), 413 above it. Vercel
  itself stops bodies over 4.5 MB. Names, emails, ids and payment tokens in a booking request have
  length caps in `@openbooking-sh/core`; notes were already capped at 500 characters.
- **Studio:** every `/studio/api` call needs a session. Importing a website is 10 an hour per
  business; deleting an account is 5 per 15 minutes.
- **Stripe webhook:** signature checked before anything is read as an event.

**Not limited in code (known gaps)**

- **Reads.** Availability, the booking page and the MCP tools that only look (`find_business`,
  `get_business_info`, `search_availability`) have no limit. Every limiter check is itself a Postgres write, so counting reads
  would add database load instead of removing it. A scraper can keep the Neon compute awake and
  spend its hours. The fix belongs in front of the function: a rate-limit rule in the Vercel
  Firewall (a dashboard setting, not code). Keep it generous: AI assistants often share a few IP
  addresses, and a tight per-IP limit would block real customers booking through them.
- **Slot hoarding from many addresses.** A holder with many IPs can hold every slot until the holds
  expire. Holds are short-lived and cost nothing to release, so this is a nuisance, not a double
  booking. Nothing is confirmed without `user_confirmed`.
- **Fake sign-ups under 100 an hour.** They are real rows and real emails. Email confirmation keeps
  them out of the OpenBooking app (`find_business`) until the owner clicks the link.
- **Self-hosted `createOpenBookingApp`** has the hold limit but no body cap; put a limit in front of
  it (most proxies have one).

**Plan limits (cannot be fixed in code)**

- **Connections.** Each function instance opens up to 3 Postgres connections (`max: 3` in
  `api/index.ts`), and a busy moment starts more instances. Use Neon's pooled (`-pooler`) host so
  those share a pool; without it a burst can hit the plan's connection limit and requests fail with
  a connection error.
- **Compute hours.** Neon's free compute sleeps when idle and wakes in a few hundred milliseconds
  to seconds. Steady traffic, including scrapers, stops it sleeping and uses up the monthly hours.
  When they are gone the database stops answering until the month turns or you upgrade.
- **Storage and branches.** The free project has a storage cap. Preview branches count (OPE-97).
- **Vercel.** The free plan has monthly caps on function invocations and CPU time, and its terms
  limit it to non-commercial use: read them before taking payment from real customers.
- **What failing looks like.** Out of connections, hours or storage, a request ends in a 500 (the
  app logs the error, and Sentry gets it if `SENTRY_DSN` is set). Nothing double-books, because
  the Postgres booking store does each check-and-reserve in one transaction under a lock.
- **Watch:** Neon's usage page (compute hours, storage, connections) and Vercel's usage page once a
  week, and see OPE-90 for alerts.

## Not done yet

- A per-business "require a key" switch (today keys identify and limit callers but do not lock
  the public API), and a key restricted to named website origins.
- Custom domains or subdomains per business (paths only: `/b/{id}`).
- Inbound calendar changes: an event moved or deleted in Google doesn't change the booking.
- Encrypting Google refresh tokens at rest (they sit in the business record as-is).
- Outlook (Nylas) and rescheduling.
- A customer who pays in time but never returns is refunded, not booked (we do not keep their
  details until they come back).
- Encrypting the Stripe key at rest.
