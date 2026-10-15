/** Small HTTP helpers shared by the USP route groups. */
import type { Context } from 'hono';
import type * as z from 'zod';
import { failure, ProtocolError } from './protocol';

/** The request body as text; a USP request body may be empty. */
export const bodyText = (c: Context) => c.req.text();

/** Parse a JSON-object body, or answer 400 `invalid_request`. */
export function jsonObject(text: string): unknown {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new ProtocolError('invalid_request', 'The request body must be a JSON object.');
}

export const readBody = async (c: Context) => jsonObject(await bodyText(c));

/** Run a handler; anything thrown becomes a protocol-error response. */
export const guard = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
  try {
    return await handler(c);
  } catch (e) {
    return failure(e);
  }
};

/** Zod failures become one `validation_error`; values are never echoed (spec 10.1.3). */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`,
  );
  throw new ProtocolError('validation_error', problems.join('; '));
}
