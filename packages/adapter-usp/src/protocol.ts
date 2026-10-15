/**
 * USP response plumbing: the `usp` envelope, `messages[]` for business outcomes, and RFC 9457
 * Problem Details for protocol errors (spec sections 9.4.1 to 9.4.3).
 *
 * The three families never mix: a business outcome is HTTP 200 with a message, a protocol error is
 * a 4xx/5xx Problem Details, and an unknown id in a *path* is always a 404.
 */
import {
  isBookingError,
  toErrorPayload,
  type BookingError,
  type ErrorPayload,
} from '@openbooking-sh/core';
import { OB_NEXT_ACTION, USP_AUTHORITY, USP_VERSION, type USP } from './constants';

type Capability = (typeof USP)['catalog' | 'availability' | 'bookings'];

export function envelope(...capabilities: Capability[]) {
  return {
    version: USP_VERSION,
    capabilities: Object.fromEntries(capabilities.map((c) => [c, [{ version: USP_VERSION }]])),
  };
}

export interface UspMessage {
  type: 'error' | 'warning' | 'info';
  code: string;
  content: string;
  severity?: 'recoverable' | 'requires_buyer_input' | 'requires_buyer_review';
  path?: string;
  [OB_NEXT_ACTION]?: string;
}

export const message = (
  type: UspMessage['type'],
  code: string,
  content: string,
  extra: Partial<Omit<UspMessage, 'type' | 'code' | 'content'>> = {},
): UspMessage => ({ type, code, content, ...extra });

/** Registered protocol errors (section 9.4.3): code → HTTP status. */
const PROTOCOL_STATUS = {
  invalid_request: 400,
  cursor_expired: 400,
  range_too_wide: 400,
  validation_error: 422,
  authentication_required: 401,
  pop_proof_missing: 401,
  pop_proof_invalid: 401,
  pop_key_mismatch: 401,
  pop_proof_replayed: 401,
  profile_not_trusted: 403,
  invalid_profile_url: 400,
  profile_unreachable: 424,
  service_not_found: 404,
  booking_not_found: 404,
  idempotency_conflict: 409,
  rate_limited: 429,
  service_unavailable: 503,
  server_error: 500,
} as const;
export type ProtocolCode = keyof typeof PROTOCOL_STATUS;

const TITLE: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

/** Thrown inside handlers to answer with a registered protocol error. */
export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolCode,
    message: string,
    readonly nextAction?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function problemResponse(
  status: number,
  detail: string,
  options: { code?: ProtocolCode; nextAction?: string; headers?: Record<string, string> } = {},
): Response {
  const body = {
    // `about:blank` is for conditions HTTP already names (405, 501); everything else is a
    // registered `https://usp-protocol.dev/errors/{slug}` type that clients branch on.
    type: options.code
      ? `${USP_AUTHORITY}/errors/${options.code.replaceAll('_', '-')}`
      : 'about:blank',
    title: TITLE[status] ?? 'Error',
    status,
    detail,
    ...(options.nextAction ? { [OB_NEXT_ACTION]: options.nextAction } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', ...options.headers },
  });
}

/**
 * Turn anything thrown into a protocol-error response. Error bodies never echo buyer-supplied
 * values (spec 10.1.3), so `detail` only carries our own text.
 */
export function failure(e: unknown): Response {
  if (e instanceof ProtocolError) {
    return problemResponse(PROTOCOL_STATUS[e.code], e.message, {
      code: e.code,
      ...(e.nextAction ? { nextAction: e.nextAction } : {}),
      ...(e.headers ? { headers: e.headers } : {}),
    });
  }
  const payload: ErrorPayload = toErrorPayload(e);
  const code = PROTOCOL_CODE_OF[payload.code] ?? 'service_unavailable';
  return problemResponse(PROTOCOL_STATUS[code], payload.message, {
    code,
    nextAction: payload.suggested_next_action,
    ...(payload.retryable ? { headers: { 'retry-after': '5' } } : {}),
  });
}

const PROTOCOL_CODE_OF: Partial<Record<ErrorPayload['code'], ProtocolCode>> = {
  validation_error: 'validation_error',
  not_found: 'validation_error',
  idempotency_conflict: 'idempotency_conflict',
  rate_limited: 'rate_limited',
  provider_error: 'service_unavailable',
};

/**
 * A failure the caller can act on, as a USP business outcome (HTTP 200 with a message), or
 * undefined when it is a protocol error that should be thrown instead.
 */
export function businessOutcome(e: unknown): UspMessage | undefined {
  if (!isBookingError(e)) return undefined;
  const hint = { [OB_NEXT_ACTION]: e.suggested_next_action };
  const code = OUTCOME_CODE[e.code];
  if (!code) return undefined;
  return message('error', code.code, e.message, { severity: code.severity, ...hint });
}

const OUTCOME_CODE: Partial<
  Record<BookingError['code'], { code: string; severity: NonNullable<UspMessage['severity']> }>
> = {
  slot_unavailable: { code: 'slot_unavailable', severity: 'recoverable' },
  hold_expired: { code: 'hold_expired', severity: 'recoverable' },
  party_size_unsupported: { code: 'capacity_exceeded', severity: 'recoverable' },
  invalid_state: { code: 'invalid_transition', severity: 'requires_buyer_review' },
  cancellation_not_allowed: { code: 'cancellation_not_allowed', severity: 'requires_buyer_review' },
  reschedule_not_allowed: { code: 'reschedule_not_allowed', severity: 'requires_buyer_review' },
};
