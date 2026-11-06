# @openbooking-sh/booking-page

## 0.13.0

### Minor Changes

- 45b5786: Age rules on hosted. Sign-up says you must be 18 or older to create an account, and every hosted booking page shows a notice above the confirm button for bookings made on behalf of a child (a parent or guardian books, with the child's name in the notes). For your own deployment the notice is an option and off by default: `childNotice` on the booking page (and `bookingPage.childNotice` in the server).
- 3d98490: The booking page API now describes itself: an OpenAPI 3.1 document at `<page>/book/api/openapi.json`, generated from zod schemas that every real response is tested against. The schemas are exported as `api` and the generator as `buildOpenApi`. Call the API with the new `@openbooking-sh/client`.
- 5b1fb9a: Add a confirm page (`/confirm/:id`) for a booking an assistant is holding: it shows the time, price and cancellation terms and confirms only when the person presses the button. `BookingPage.confirmUrl(booking)` returns its link, and `GET /api/holds/:id` returns what the page shows (a confirmed booking reveals no code or name).
- bb06329: Payment terms where the customer pays, and a clearer way out. The booking page's pay button names the deposit amount, and the lines under it say what happens to the deposit if they cancel. The confirmation email for a paid booking says what was paid and what happens to the deposit on cancellation. The manage page says what cancelling costs right now, and one press cancels while it is free (it still asks once more when a fee applies). The booking API's booking detail gains `cancel_now` (free, fee, refund) for confirmed bookings, and the client types follow.
- 92f6c50: Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.

### Patch Changes

- dd8e9ca: API keys for hosted businesses, so a site with no backend can call its own booking API. Owners make keys in Studio → Settings → API keys (a name, and `read` or `book`); the secret is shown once and only a hash is stored. Send it as `x-openbooking-key` or `Authorization: Bearer obk_…` to `/b/{id}/book/api/*` or `/b/{id}/mcp`. Each key works for one business, is rate-limited on its own (300 a minute), shows when it was last used and can be revoked. Calls without a key stay public as before: a key identifies and limits a caller, it does not lock the API. New `apiKeys` option on `createHostedApp` (memory by default), `PostgresApiKeyStore` and `postgresStores(db).apiKeys` with migration 6 (`ob_api_keys`), and `api_keys` on Studio's `SettingsView`. The booking page's CORS preflight now allows the `x-openbooking-key` header.
- c8d546c: The booking, manage and confirm pages now wrap their content in a `<main>` landmark, so screen readers can jump to it.
- Updated dependencies [6ae5bb8]
- Updated dependencies [e6a751c]
- Updated dependencies [8e2e69d]
- Updated dependencies [3825c49]
- Updated dependencies [5dc9991]
- Updated dependencies [db42a3d]
  - @openbooking-sh/core@0.13.0

## 0.12.0

### Patch Changes

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

- Updated dependencies [12ec3a2]
  - @openbooking-sh/core@0.10.0

## 0.9.0

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

- 671f98e: WebMCP follows the current draft: tools register on `document.modelContext` (falling back to `navigator.modelContext`), resolve to JSON strings and reject on errors, and carry `readOnlyHint` / `consequentialHint` annotations. Older builds keep the MCP-style content arrays.
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
