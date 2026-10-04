# Hosted OpenBooking

Many businesses on one deployment (`@openbooking/hosted`): sign-up and Studio settings, Google
Calendar sync, confirmation emails, one OpenBooking app across every business, and a public booking
page per business.

```sh
pnpm dev:hosted     # seeds "Studio Nord"; Studio login demo@openbooking.sh / openbooking-demo
```

## Routes

| Path                                                    | What                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /signup`, `POST /api/signup`, `POST /api/login`    | Owner accounts (email + password, scrypt; 30-day signed session token)                          |
| `GET /studio`, `/studio/api/*`                          | Studio for the logged-in business, including **Settings**                                       |
| `ALL /mcp`                                              | **The OpenBooking app**: `find_business` plus the five booking tools, each taking `business_id` |
| `/b/{id}`                                               | The business: booking page for browsers, JSON index otherwise                                   |
| `/b/{id}/mcp`, `/b/{id}/ucp/*`, `/b/{id}/.well-known/*` | Per-business MCP, UCP and A2A card (same as a self-hosted single business)                      |
| `/b/{id}/book/*`                                        | Booking page API, manage links (`/book/manage/{booking}?code=`), `llms.txt`                     |
| `GET /oauth/google/callback`                            | Google Calendar connection                                                                      |

`{id}` is the business's URL name (`studio-nord`), fixed at sign-up, and is also its
`business_id` and the venue id on its bookings.

## Setup in ten minutes

Sign-up asks for the business name, type, city, owner name, email and password. It creates a
business that is bookable straight away: the owner as the only staff member, typical services for
the type (example NOK prices), weekday hours, and free cancellation until 24 hours before. Studio
opens on **Settings** with a checklist and the links to share (booking page, "Book me through
ChatGPT/Claude" links that open the assistant with the booking page, and the MCP URL).

Settings are in owner terms (`BusinessSettingsSchema` in `@openbooking/studio`): profile, opening
hours per weekday, closed dates, staff, services (duration, price, who does it), one cancellation
rule as percentages of the price, booking rules, email preferences, and whether the business is
listed in the OpenBooking app. `catalog.ts` turns them into the provider configuration.

Deposits are not offered in hosted settings yet; they need online payments (planned: Stripe payment
links).

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

## Storage

Everything stateful sits behind an interface with an in-memory default. Hosted takes them as
options to `createHostedApp`:

| Option            | Interface             | Package         | Notes                                                                                     |
| ----------------- | --------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `bookings`        | `BookingRecordStore`  | provider-memory | ✅ `PostgresBookingStore`. One store for all businesses (`list()` filters by `venue_id`). |
| `idempotency`     | `IdempotencyStore`    | core            | ✅ `PostgresIdempotencyStore`. Shared; hosted prefixes keys with the business id.         |
| `activityFor`     | `(id) => ActivityLog` | studio          | Memory. `PostgresActivityLog` is one log per database; needs a `business_id` column.      |
| `businesses`      | `BusinessStore`       | hosted          | Memory. One row per business: JSON record, unique `id` and lower(`owner.email`).          |
| `notificationLog` | `NotificationLog`     | notifications   | Memory. `claim(key)` = insert-if-absent on a unique key.                                  |
| `calendarLinks`   | `CalendarLinkStore`   | google-calendar | Memory. booking id → Google event.                                                        |

With `DATABASE_URL` set, the Vercel entry (`OPENBOOKING_MODE=hosted`) keeps bookings and
idempotency in Postgres, but accounts still reset on cold starts until a `BusinessStore` lands.
Google refresh tokens are stored in the business record as-is; encrypt them at rest in that store.

## ChatGPT and Claude directory submissions

The OpenBooking app (`/mcp`) is built for this: no login for customers, one server for every
business, read-only tools annotated, and consent enforced by the engine (`user_confirmed`). Still to
do by hand before submitting:

- [ ] Deploy hosted with durable storage on a stable domain (e.g. `app.openbooking.sh/mcp`).
- [ ] Publish a privacy policy and terms (we process customer names, emails and phone numbers on
      behalf of businesses) and a support contact.
- [ ] App name, icon, short and long description, example prompts ("Book a haircut in Oslo on
      Friday afternoon").
- [ ] Test the full flow in ChatGPT developer mode and as a Claude custom connector.
- [ ] Submit to the ChatGPT app directory and the Claude connectors directory, and check each
      program's current requirements at submission time.

## Not done yet

- Password reset and email verification (owners can't recover a forgotten password yet).
- Login rate limiting.
- Custom domains or subdomains per business (paths only: `/b/{id}`).
- Inbound calendar changes: an event moved or deleted in Google doesn't change the booking.
- Outlook (Nylas), deposits, rescheduling.
