# @openbooking-sh/studio

## 0.13.0

### Minor Changes

- e6a751c: Add the `booking.expired` webhook event, and an `expire` engine event, for holds that lapse without being confirmed or cancelled. Nothing runs when a hold expires, so the event is sent when a read first notices it or when `service.sweepExpired()` runs (call it from a cron or timer to report lapses nobody reads). Each expiry is announced at most once across instances through a new `expiryClaims` option (hosted reuses its email dedupe log; pass `PostgresNotificationLog` when running several instances on one database). The event carries no actor, and Studio shows it as a system entry.
- 92f6c50: Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.
- db42a3d: Add the "Let assistants and platforms book me directly (USP)" setting (`assistants.usp`: off, confirm, instant), and show bookings made through USP as their own channel with the calling platform's name.

### Patch Changes

- Updated dependencies [e6a751c]
- Updated dependencies [3825c49]
- Updated dependencies [db42a3d]
  - @openbooking-sh/core@0.13.0

## 0.12.0

### Patch Changes

- e3fac6c: Stripe webhooks for hosted deposits. Connecting a Stripe key now also registers a webhook endpoint
  (when the key may write Webhook Endpoints). When a customer pays and never returns to the booking
  page, the webhook refunds the payment once the hold has expired; while the hold is live it asks
  Stripe to deliver again later. New `BookingService.reconcilePayment`, and `StripePayments`
  `createWebhook` / `deleteWebhook` plus `verifyWebhook` for checking Stripe's signature.
- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0

## 0.11.0

### Minor Changes

- 10e30b3: Hosted businesses can take deposits through their own Stripe account. Studio has an Online
  payments card (connect a key, set a deposit percentage); the booking page sends the customer to
  Stripe Checkout and confirms the booking when they return. The booking page API now passes
  `payment_token` through to the engine.

## 0.10.0

### Patch Changes

- 7fdf84e: Logging out of Studio now ends every session of the account on the server, so a copied token stops
  working at once (it used to live on until it expired). Session tokens now last 7 days instead of 30.
- Updated dependencies [12ec3a2]
  - @openbooking-sh/core@0.10.0

## 0.9.0

### Minor Changes

- dd48af2: Hosted owners can download everything stored about their business and close their account
  (GDPR articles 15 and 17), from the compliance audit.

  - Studio, Settings, "Your account": download a JSON file (account, settings, every booking; never the
    password hash or Google tokens) and delete the account with the password. Deleting removes calendar
    links, activity and attribution, idempotency records, all bookings and finally the account, in that
    order, so a failed attempt can be retried.
  - New optional store methods: `BookingRecordStore.deleteVenue`, `BusinessStore.delete`,
    `IdempotencyStore.deletePrefix`, `ActivityLog.clear`, `RateLimiter.purge`. Memory and Postgres
    implement them; closing an account refuses with 501 when the stores cannot delete.
  - The daily purge also clears expired rate-limit windows, which are keyed by IP address.

- dfb5e56: Customer data rights (GDPR articles 15 and 17) and retention, from the compliance audit.

  - `BookingRecordStore` gets an optional `anonymize(query, now)`: it removes the customer's name,
    contact details and notes from bookings and keeps the booking itself. Implemented for the memory
    and Postgres stores. Upcoming bookings (held or confirmed, not yet ended) are kept and counted, and
    a query must name a customer or an age, so it can never erase everything.
  - Studio gets `dataRights` (an adapter) and, when set, `POST /api/customers/export` and
    `POST /api/customers/erase`, plus a "Customer data" card in Settings. POST so an email address
    or phone number stays out of URLs and logs.
  - Hosted wires it up, and removes customer data from bookings that ended more than `retentionDays`
    ago (default 730) through `GET /api/maintenance/purge`, which needs `cronSecret` (`CRON_SECRET`).
    `vercel.json` runs it daily.

### Patch Changes

- c766b13: Privacy basics from the compliance audit:

  - No more Google Fonts: the booking page, Studio, sign-up and setup no longer load anything from
    Google, so a visit does not hand the visitor's IP address to a third party. The font stack falls
    back to the system font (Geist still applies if installed).
  - The PostHog snippet on owner pages counts page views only: autocapture and heatmaps are off and
    all text is masked, because Studio shows customer names and notes. The password reset page no
    longer carries the snippet, since its link holds the reset token.
  - Migration 3 turns on row level security for every `ob_` table. With no policies, a role that does
    not own the tables (a REST or Data API layer's anon role) sees nothing. The role OpenBooking
    connects as must be the one that created the tables, as it is by default.

- e2d4873: Accessibility basics (WCAG 2.1 AA) from the compliance audit:

  - Muted text is darker in light mode (`#646b80`, 4.6:1 or better on every background; it was `#8a90a3`, about 3:1) on the booking page, Studio, sign-up, setup, reset and the booking emails.
  - Errors and status messages are announced (`role="alert"` and a polite live region), so a screen reader user hears "no free times" or a failed sign-up.
  - Service, staff, date and time buttons say whether they are selected (`aria-pressed`).
  - Studio's new-booking form ties each label to its field, and the login fields have names.
  - The embed popup moves focus into the dialog, keeps it there while open, and returns it to the button that opened it. The decorative logo is hidden from screen readers.

- Updated dependencies [dd48af2]
- Updated dependencies [eb99a97]
  - @openbooking-sh/core@0.9.0

## 0.7.0

### Patch Changes

- Updated dependencies [7c9ad2d]
- Updated dependencies [e4b56d6]
- Updated dependencies [783a56e]
  - @openbooking-sh/core@0.7.0

## 0.2.0

### Minor Changes

- 4d9f0fc: Better for agents and safer in public, from a fresh-eyes test of the SDK:

  - New MCP tool `get_business_info`: services, staff, opening hours and booking window.
  - Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
  - `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
  - New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
  - Providers can expose opening hours with `getVenueInfo`.

### Patch Changes

- Updated dependencies [4d9f0fc]
  - @openbooking-sh/core@0.2.0

## 0.1.1

### Patch Changes

- 77a3ffa: Business, service and staff ids from names with å, æ, ø or accents are now clean: "Bjørn & Åse Frisør" becomes `bjorn-ase-frisor` (was `bjorn-a-se-frisor`). Existing ids don't change.
