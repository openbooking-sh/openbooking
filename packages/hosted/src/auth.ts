/**
 * Owner accounts: scrypt password hashes and stateless signed tokens (HMAC-SHA256). The same
 * signer protects the Google OAuth `state` so a callback can't be pointed at another business.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(key, expected);
}

export interface Signer {
  /** `purpose` separates token kinds, so a session token is never a valid OAuth state. */
  sign(purpose: string, subject: string, ttlMs: number): string;
  /** The subject, or undefined if the token is forged, expired or for another purpose. */
  verify(purpose: string, token: string): string | undefined;
}

export function createSigner(secret: string, now: () => number = Date.now): Signer {
  if (secret.length < 16) throw new Error('The session secret must be at least 16 characters.');
  const mac = (data: string) => createHmac('sha256', secret).update(data).digest('base64url');
  return {
    sign(purpose, subject, ttlMs) {
      const body = `${Buffer.from(subject).toString('base64url')}.${now() + ttlMs}.${randomBytes(6).toString('base64url')}`;
      return `${body}.${mac(`${purpose}:${body}`)}`;
    },
    verify(purpose, token) {
      const parts = token.split('.');
      if (parts.length !== 4) return undefined;
      const body = parts.slice(0, 3).join('.');
      const given = Buffer.from(parts[3]!);
      const want = Buffer.from(mac(`${purpose}:${body}`));
      if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
      if (Number(parts[1]) <= now()) return undefined;
      return Buffer.from(parts[0]!, 'base64url').toString('utf8');
    },
  };
}

export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const OAUTH_STATE_TTL_MS = 15 * 60_000;
