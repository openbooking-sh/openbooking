/**
 * UCP version pinning.
 *
 * `dev.ucp.lodging.booking` exists only on UCP `main` (commit b0e81ade, 2026-09-30), marked
 * "Draft - Work in Progress", and is not part of any tagged release (latest: 2026-08-25). The
 * profile `version` must match `^\d{4}-\d{2}-\d{2}$`, so we pin to the date of the commit we
 * implemented against. SPEC AMBIGUITY: see docs/SPEC-NOTES.md#versioning.
 */
export const UCP_VERSION = '2026-09-30';
export const UCP_SPEC_COMMIT = 'b0e81ade';
/** The UCP docs site serves `main` under /draft/. */
export const UCP_SITE = 'https://ucp.dev/draft';

/** Capability / service names defined by UCP. */
export const UCP = {
  service: 'dev.ucp.lodging',
  booking: 'dev.ucp.lodging.booking',
  cancellationPolicy: 'dev.ucp.lodging.policy.cancellation',
  paymentTerms: 'dev.ucp.common.payment.terms',
} as const;

/**
 * OpenBooking's own namespace. UCP reserves `dev.ucp.*`; vendors must use a domain they control.
 */
export const OPENBOOKING_EXT_VERSION = '2026-10-02';
export const OB = {
  /** EXTENSION of dev.ucp.lodging.booking: time slots, consent flag, payment token, agent guidance. */
  booking: 'sh.openbooking.booking',
  /** EXTENSION: standalone availability search capability (UCP has none). */
  availability: 'sh.openbooking.availability',
} as const;

export const OPENBOOKING_SPEC_URL =
  'https://github.com/openbooking/openbooking/blob/main/docs/SPEC-NOTES.md';
