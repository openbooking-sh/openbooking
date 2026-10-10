---
'@openbooking-sh/booking-page': patch
'@openbooking-sh/studio': patch
'@openbooking-sh/hosted': patch
'@openbooking-sh/notifications': patch
---

Accessibility basics (WCAG 2.1 AA) from the compliance audit:

- Muted text is darker in light mode (`#646b80`, 4.6:1 or better on every background; it was `#8a90a3`, about 3:1) on the booking page, Studio, sign-up, setup, reset and the booking emails.
- Errors and status messages are announced (`role="alert"` and a polite live region), so a screen reader user hears "no free times" or a failed sign-up.
- Service, staff, date and time buttons say whether they are selected (`aria-pressed`).
- Studio's new-booking form ties each label to its field, and the login fields have names.
- The embed popup moves focus into the dialog, keeps it there while open, and returns it to the button that opened it. The decorative logo is hidden from screen readers.
