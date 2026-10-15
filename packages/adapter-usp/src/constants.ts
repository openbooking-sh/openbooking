/**
 * USP version pinning.
 *
 * The spec header says version `2026-08-20`, status Draft, yet breaking renames (for example the
 * availability `date_bounds_timezone`) have landed without a version bump. So we pin the commit we
 * implemented and tested against (the vendored fixtures in `test/fixtures/usp-spec`), not just the
 * version.
 */
export const USP_VERSION = '2026-08-20';
export const USP_SPEC_COMMIT = '78363d7';
/** Spec and schema URLs must be on the namespace authority (spec section 2.5). */
export const USP_AUTHORITY = 'https://usp-protocol.dev';

/** Names defined by USP. `dev.usp-protocol.*` is reserved; vendors use a domain they control. */
export const USP = {
  services: 'dev.usp-protocol.services',
  catalog: 'dev.usp-protocol.services.catalog',
  availability: 'dev.usp-protocol.services.availability',
  bookings: 'dev.usp-protocol.services.bookings',
} as const;

export const USP_SPEC = {
  spec: `${USP_AUTHORITY}/specification`,
  rest: `${USP_AUTHORITY}/schemas/openapi/usp-rest.json`,
  mcp: `${USP_AUTHORITY}/schemas/openrpc/usp-mcp.json`,
  catalog: {
    spec: `${USP_AUTHORITY}/specification#3-service-catalog`,
    schema: `${USP_AUTHORITY}/schemas/services/catalog.json`,
  },
  availability: {
    spec: `${USP_AUTHORITY}/specification#4-availability`,
    schema: `${USP_AUTHORITY}/schemas/services/availability.json`,
  },
  bookings: {
    spec: `${USP_AUTHORITY}/specification#5-booking-lifecycle`,
    schema: `${USP_AUTHORITY}/schemas/services/booking.json`,
  },
} as const;

/**
 * OpenBooking's own members on USP messages and problem details. USP bodies are open objects, so
 * extra members are allowed; platforms that do not know them ignore them.
 */
export const OB_NEXT_ACTION = 'sh.openbooking.suggested_next_action';
