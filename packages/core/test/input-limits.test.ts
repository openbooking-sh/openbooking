import { describe, expect, it } from 'vitest';
import { ConfirmInputSchema, HoldInputSchema } from '../src';

const ok = { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' };

describe('input size limits', () => {
  it('accepts ordinary customers and ids', () => {
    expect(
      HoldInputSchema.safeParse({ slot_id: 's1', idempotency_key: 'key-12345', customer: ok })
        .success,
    ).toBe(true);
  });

  it('refuses names, emails and ids that could only be abuse', () => {
    const hold = (over: object) =>
      HoldInputSchema.safeParse({ slot_id: 's1', idempotency_key: 'key-12345', ...over }).success;
    expect(hold({ customer: { ...ok, first_name: 'A'.repeat(101) } })).toBe(false);
    expect(hold({ customer: { ...ok, last_name: 'A'.repeat(101) } })).toBe(false);
    expect(hold({ customer: { ...ok, email: `${'a'.repeat(250)}@example.com` } })).toBe(false);
    expect(hold({ slot_id: 's'.repeat(201) })).toBe(false);
    expect(
      ConfirmInputSchema.safeParse({
        booking_id: 'b'.repeat(201),
        idempotency_key: 'key-12345',
        user_confirmed: true,
      }).success,
    ).toBe(false);
  });
});
