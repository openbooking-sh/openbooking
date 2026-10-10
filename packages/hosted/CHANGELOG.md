# @openbooking-sh/hosted

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
- Updated dependencies [c766b13]
- Updated dependencies [dfb5e56]
- Updated dependencies [e2d4873]
  - @openbooking-sh/core@0.9.0
  - @openbooking-sh/provider-memory@0.9.0
  - @openbooking-sh/studio@0.9.0
  - @openbooking-sh/booking-page@0.9.0
  - @openbooking-sh/notifications@0.9.0
  - @openbooking-sh/adapter-mcp@0.9.0
  - @openbooking-sh/google-calendar@0.9.0
  - @openbooking-sh/server@0.9.0

## 0.7.0

### Patch Changes

- Updated dependencies [660944c]
- Updated dependencies [7c9ad2d]
- Updated dependencies [e4b56d6]
- Updated dependencies [783a56e]
- Updated dependencies [671f98e]
  - @openbooking-sh/server@0.7.0
  - @openbooking-sh/core@0.7.0
  - @openbooking-sh/provider-memory@0.7.0
  - @openbooking-sh/adapter-mcp@0.7.0
  - @openbooking-sh/booking-page@0.7.0
  - @openbooking-sh/google-calendar@0.7.0
  - @openbooking-sh/notifications@0.7.0
  - @openbooking-sh/studio@0.7.0

## 0.6.0

### Minor Changes

- 899afde: Adds `/sitemap.xml` (every listed, bookable business's booking page) and `/robots.txt` pointing to it, with Studio, setup and the API excluded from indexing.

### Patch Changes

- Updated dependencies [899afde]
  - @openbooking-sh/server@0.6.0

## 0.5.0

### Minor Changes

- b375ced: Removes the marketing-site visitor tools: the `/api/visit` Slack beacon and the `TRACKER_JS` click/scroll tracker (no longer exported). They were for watching openbooking.sh, not part of hosting. Owner pages keep the plain cookieless PostHog snippet, sign-up source and setup-step events.

## 0.4.1

### Patch Changes

- 7d25791: Visitor messages treat the deployment's own domain as home instead of openbooking.sh, so self-hosted sites don't list themselves as the referrer.

## 0.4.0

### Minor Changes

- 6e7ca09: Visitor messages in Slack now include the source and campaign, and a second message when the visitor leaves a page: time on page, how far they read, sections seen and what they clicked. The tracker keeps that journey in memory (`window.__obJourney`); the beacon snippet is in docs/HOSTED.md.

## 0.3.0

### Minor Changes

- 17bf1ca: Better analytics on owner pages (still cookieless, nothing personal): visits carry referrer, `utm_*`, `from` and landing page; named events for sign-up CTA clicks, outbound links, copies, FAQ opens, sections viewed, scroll depth and setup steps; heatmaps on. Sign-ups record their `source` (the website button, campaign or referring site), shown in `business_signed_up` and the Slack message. `TRACKER_JS` is exported for other sites.

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
  - @openbooking-sh/provider-memory@0.2.0
  - @openbooking-sh/adapter-mcp@0.2.0
  - @openbooking-sh/server@0.2.0
  - @openbooking-sh/studio@0.2.0
  - @openbooking-sh/booking-page@0.2.0
  - @openbooking-sh/google-calendar@0.2.0
  - @openbooking-sh/notifications@0.2.0

## 0.1.1

### Patch Changes

- 77a3ffa: Business, service and staff ids from names with å, æ, ø or accents are now clean: "Bjørn & Åse Frisør" becomes `bjorn-ase-frisor` (was `bjorn-a-se-frisor`). Existing ids don't change.
- Updated dependencies [77a3ffa]
  - @openbooking-sh/studio@0.1.1
