# @openbooking-sh/notifications

## 0.13.0

### Minor Changes

- bb06329: Payment terms where the customer pays, and a clearer way out. The booking page's pay button names the deposit amount, and the lines under it say what happens to the deposit if they cancel. The confirmation email for a paid booking says what was paid and what happens to the deposit on cancellation. The manage page says what cancelling costs right now, and one press cancels while it is free (it still asks once more when a fee applies). The booking API's booking detail gains `cancel_now` (free, fee, refund) for confirmed bookings, and the client types follow.
- 92f6c50: Link the privacy policy and terms where people give or see their data. Hosted sign-up asks owners to accept the terms and privacy policy, and hosted booking pages, Studio and every email link to them. For your own deployment, the links are options and off by default (a self-hosted business owns its own policy): `privacyUrl` on the booking page (and `bookingPage.privacyUrl` in the server), `legal: { privacyUrl, termsUrl }` on Studio, and `privacyUrl` in the notification config.
- edba76d: Customers can unsubscribe from a business's emails. Customer emails carry an unsubscribe link and the RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers (`EmailMessage.headers`, passed on by `ResendMailer`). Hosted serves `/unsubscribe`: a GET shows a button, the POST records a hash of the address for that business, and nothing more is sent to it. New `SuppressionList` (`MemorySuppressionList`, `PostgresSuppressionList`, migration 5), `isSuppressed` and `unsubscribeUrl` options in `attachNotifications`, and a `suppressions` option on `createHostedApp` (`stores.suppressions` with Postgres).
- 074f42f: Waitlist offer email. `attachWaitlistNotifications({ waitlist, mailer, config })` emails the customer when a slot is held for them from the waitlist (what, when, until when, a link to confirm, the cancellation policy), once per offer, honouring unsubscribes. `renderWaitlistOfferEmail` is the template.

### Patch Changes

- Updated dependencies [6ae5bb8]
- Updated dependencies [de2a7ef]
- Updated dependencies [e6a751c]
- Updated dependencies [7f71337]
- Updated dependencies [8e2e69d]
- Updated dependencies [3825c49]
- Updated dependencies [086199e]
- Updated dependencies [02b8605]
- Updated dependencies [5dc9991]
- Updated dependencies [db42a3d]
- Updated dependencies [cdbb3c4]
- Updated dependencies [074f42f]
  - @openbooking-sh/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e3fac6c]
  - @openbooking-sh/core@0.12.0

## 0.10.0

### Patch Changes

- Updated dependencies [12ec3a2]
  - @openbooking-sh/core@0.10.0

## 0.9.0

### Patch Changes

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

### Patch Changes

- Updated dependencies [4d9f0fc]
  - @openbooking-sh/core@0.2.0
