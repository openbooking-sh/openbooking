import type { ErrorCode } from './types';

/**
 * Every failure is an `OpenBookingError`. Errors from the API carry its `code` and
 * `suggestedNextAction`; two more codes cover what happens before an answer arrives.
 */
export class OpenBookingError extends Error {
  override readonly name = 'OpenBookingError';
  constructor(
    /** An API error code, `network_error` (no answer) or `invalid_response` (not our API). */
    readonly code: ErrorCode | 'network_error' | 'invalid_response',
    message: string,
    readonly options: {
      /** HTTP status, 0 when there was no answer. */
      status?: number;
      /** What to do next, in words. Always set for API errors. */
      suggestedNextAction?: string;
      /** Retrying the same call later may succeed. */
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }

  get status(): number {
    return this.options.status ?? 0;
  }
  get suggestedNextAction(): string | undefined {
    return this.options.suggestedNextAction;
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  get details(): Record<string, unknown> | undefined {
    return this.options.details;
  }
}
