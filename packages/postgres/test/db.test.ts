import { describe, expect, it } from 'vitest';
import { strictSsl } from '../src/db';

describe('strictSsl', () => {
  it('makes hosted sslmode=require explicit as verify-full', () => {
    expect(strictSsl('postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require')).toBe(
      'postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full',
    );
    expect(strictSsl('postgres://h/db?channel_binding=require&sslmode=prefer')).toBe(
      'postgres://h/db?channel_binding=require&sslmode=verify-full',
    );
  });

  it('leaves other URLs alone', () => {
    for (const url of [
      'postgres://localhost/db',
      'postgres://h/db?sslmode=disable',
      'postgres://h/db?sslmode=require&uselibpqcompat=true',
    ]) {
      expect(strictSsl(url)).toBe(url);
    }
  });
});
