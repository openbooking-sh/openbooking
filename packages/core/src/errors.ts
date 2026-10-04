/**
 * Structured, actionable errors. Every error an agent can see has the shape
 * `{ code, message, suggested_next_action }` so the agent knows what to do next without guessing.
 *
 * Codes are lowercase snake_case like UCP `messages[].code` (e.g. UCP `inventory_exhausted`).
 */
import * as z from 'zod';

export const ErrorCodeSchema = z.enum([
  'validation_error',
  'not_found',
  'slot_unavailable',
  'party_size_unsupported',
  'hold_expired',
  'invalid_state',
  'user_confirmation_required',
  'customer_details_required',
  'payment_required',
  'payment_failed',
  'cancellation_not_allowed',
  'idempotency_conflict',
  'operation_not_supported',
  'provider_error',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  suggested_next_action: z.string(),
  /** True when retrying the *same* call later may succeed (e.g. transient provider failure). */
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

const DEFAULT_NEXT_ACTION: Record<ErrorCode, string> = {
  validation_error: 'Fix the invalid fields listed in the message and call the tool again.',
  not_found:
    'Check the id. Use search_availability to find slots, or ask the user for the correct booking id.',
  slot_unavailable:
    'This slot was just taken. Call search_availability again and offer the user the closest alternatives.',
  party_size_unsupported:
    'The venue cannot seat this party size online. Suggest the user contact the venue directly, or search with a different party size.',
  hold_expired:
    'The hold expired and the slot was released. Call search_availability, then hold_slot again, and confirm promptly after the user agrees.',
  invalid_state: 'Call get_booking to see the current status before trying again.',
  user_confirmation_required:
    'Show the user the booking summary, cancellation policy and deposit terms, ask for explicit approval, then call again with user_confirmed=true.',
  customer_details_required:
    'Ask the user for first name, last name and an email or phone number, then call again with customer details.',
  payment_required:
    'This booking needs a deposit. Obtain a payment token for the deposit amount and call again with payment_token.',
  payment_failed: 'The payment was declined. Ask the user for another payment method.',
  cancellation_not_allowed:
    'The booking can no longer be cancelled online. Tell the user to contact the venue directly.',
  idempotency_conflict:
    'This idempotency_key was already used for a different request. Generate a new key for a new action; reuse a key only for exact retries.',
  operation_not_supported:
    'This provider does not support the operation. Tell the user it must be done with the venue directly.',
  provider_error:
    'A temporary problem occurred at the booking system. Retry the same call with the same idempotency_key shortly.',
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['provider_error']);

export interface BookingErrorOptions {
  suggested_next_action?: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

export class BookingError extends Error {
  readonly code: ErrorCode;
  readonly suggested_next_action: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: BookingErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BookingError';
    this.code = code;
    this.suggested_next_action = options.suggested_next_action ?? DEFAULT_NEXT_ACTION[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details;
  }

  toJSON(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      suggested_next_action: this.suggested_next_action,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isBookingError(e: unknown): e is BookingError {
  return e instanceof BookingError;
}

/** Turn a zod error into a single readable `validation_error`. */
export function fromZodError(error: z.ZodError, context?: string): BookingError {
  const problems = error.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(input)';
    return `${path}: ${i.message}`;
  });
  return new BookingError(
    'validation_error',
    `${context ? `${context}: ` : ''}${problems.join('; ')}`,
    { details: { issues: error.issues.map((i) => ({ path: i.path, message: i.message })) } },
  );
}

/** Normalise anything thrown into an agent-safe payload. Unknown errors never leak internals. */
export function toErrorPayload(e: unknown): ErrorPayload {
  if (isBookingError(e)) return e.toJSON();
  if (e instanceof z.ZodError) return fromZodError(e).toJSON();
  return new BookingError('provider_error', 'Unexpected error in the booking system.').toJSON();
}
