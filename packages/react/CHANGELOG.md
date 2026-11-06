# @openbooking-sh/react

## 0.13.0

### Minor Changes

- ce564b1: New package: a React `<BookingWidget>` and headless hooks (`useInfo`, `useAvailability`, `useBooking`) on the typed client. The customer's tick box is the only way `user_confirmed` is sent, and each hold, confirm or cancel keeps one idempotency key until it succeeds.

### Patch Changes

- Updated dependencies [bb06329]
- Updated dependencies [3d98490]
  - @openbooking-sh/client@0.13.0
