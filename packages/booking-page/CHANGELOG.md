# @openbooking-sh/booking-page

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
