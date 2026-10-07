# Hosted OpenBooking

Many businesses on one deployment (`@openbooking-sh/hosted`): sign-up and Studio settings, Google
Calendar sync, confirmation emails, one OpenBooking app across every business, and a public booking
page per business.

```sh
pnpm dev:hosted     # seeds "Studio Nord"; Studio login demo@openbooking.sh / openbooking-demo
```

## Routes

| Path                                                          | What                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /signup`, `POST /api/signup`, `POST /api/login`          | Owner accounts (email + password, scrypt; 30-day signed session token)                         |
| `GET /studio`, `/studio/api/*`                                | Studio for the logged-in business, including **Settings**                                      |
| `ALL /mcp`                                                    | **The OpenBooking app**: `find_business` plus the six booking tools, each taking `business_id` |
| `/b/{id}`                                                     | The business: booking page for browsers, JSON index otherwise                                  |
| `/b/{id}/mcp`, `/b/{id}/ucp/*`, `/b/{id}/.well-known/*`       | Per-business MCP, UCP and A2A card (same as a self-hosted single business)                     |
| `/b/{id}/book/*`                                              | Booking page API, manage links (`/book/manage/{booking}?code=`), `llms.txt`                    |
| `GET /b/{id}/embed.js`                                        | The website snippet (see below)                                                                |
| `GET /reset`, `POST /api/password/*`, `GET /api/verify-email` | Password reset and email confirmation                                                          |
| `GET /oauth/google/callback`                                  | Google Calendar connection                                                                     |

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

Deposits are not offered in hosted settings yet; they need online payments (planned: Stripe payment
links).

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

## Emails

Set `RESEND_API_KEY` (and `MAIL_FROM`, default `bookings@openbooking.sh`, which must be a verified
Resend domain). Without it nothing is sent (`pnpm dev:hosted` prints them instead).

- Customer: confirmation with an `.ics` invite and a manage link; cancellation with `METHOD:CANCEL`.
- Owner: new and cancelled bookings, except ones staff made in Studio.
- Deduplicated per booking, so agent retries never send twice.

## Owner accounts

- **Password reset:** `/reset` emails a link that works once (it is tied to the current password
  hash) and expires in an hour. Saving a new password logs out every other session.
- **Email confirmation:** sign-up sends a confirmation link. With email enabled, a business is
  listed in the OpenBooking app (`find_business`) only after the owner confirmed it; its booking
  page and per-business MCP work straight away. Studio shows a "Confirm your email" step.
- **Rate limits** (`LIMITS` in `limits.ts`): login per email and per IP, sign-up per IP, reset
  emails per email and IP. The IP comes from `x-real-ip` / `x-forwarded-for`, which Vercel sets;
  pass `clientIp` when running without a proxy.

## Storage

Everything stateful sits behind an interface with an in-memory default, and `@openbooking-sh/postgres`
implements all of them. `postgresStores(db)` returns them ready to pass to `createHostedApp`:

| Option            | Interface             | Postgres                    | Notes                                                  |
| ----------------- | --------------------- | --------------------------- | ------------------------------------------------------ |
| `businesses`      | `BusinessStore`       | `PostgresBusinessStore`     | JSON record; unique id and lower-cased owner email.    |
| `bookings`        | `BookingRecordStore`  | `PostgresBookingStore`      | One store for all businesses (venue id = business id). |
| `idempotency`     | `IdempotencyStore`    | `PostgresIdempotencyStore`  | Shared; hosted prefixes keys with the business id.     |
| `activityFor`     | `(id) => ActivityLog` | `PostgresActivityLog`       | One `scope` per business.                              |
| `notificationLog` | `NotificationLog`     | `PostgresNotificationLog`   | Insert-if-absent, so no email goes out twice.          |
| `calendarLinks`   | `CalendarLinkStore`   | `PostgresCalendarLinkStore` | Booking id → Google event.                             |
| `rateLimiter`     | `RateLimiter`         | `PostgresRateLimiter`       | Fixed windows shared by every instance.                |

With `DATABASE_URL` set, the Vercel entry (`OPENBOOKING_MODE=hosted`) and `pnpm dev:hosted` use all
of them and create the tables on start.
Google refresh tokens are stored in the business record as-is; encrypt them at rest in that store.

## Observability

All optional, set as environment variables on the Vercel project:

| Variable                      | Tool                          | What it does                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                  | Sentry (EU region)            | Server errors plus anything logged with `console.error` (failed emails, calendar syncs). No IPs, cookies or request bodies.                                                                                                                                                                                                                    |
| `POSTHOG_KEY`, `POSTHOG_HOST` | PostHog (EU cloud by default) | Server events keyed by business id: `business_signed_up`, `email_verified`, `website_imported`, `google_calendar_connected`, `password_reset`, `slot_held`, `booking_confirmed` and `booking_cancelled` with their channel. Plus a cookieless browser snippet on owner pages (sign-up, setup, reset, Studio), never on customer booking pages. |
| `SLACK_WEBHOOK_URL`           | Slack incoming webhook        | Operator notifications: new business, email confirmed, Google connected, every booking and cancellation with its channel, server errors (at most one a minute). Business names only. Previews prefix `[preview]`.                                                                                                                              |

No customer names, emails or phone numbers are sent to any of them. Background work (emails,
calendar sync, analytics, Slack) finishes after the response through `waitUntil(hosted.idle())`.

## Not done yet

- Custom domains or subdomains per business (paths only: `/b/{id}`).
- Inbound calendar changes: an event moved or deleted in Google doesn't change the booking.
- Encrypting Google refresh tokens at rest (they sit in the business record as-is).
- Outlook (Nylas), deposits, rescheduling.
