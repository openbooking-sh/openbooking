/**
 * Server-supplied nonces for `platform_key_pop` proofs (spec 10.1.6, "Replay defence"): a business
 * MAY require one, and a platform MUST be able to be challenged for one. A nonce makes a captured
 * proof worthless after a few minutes, where `jti` alone only has to be remembered for two
 * minutes but cannot say whether the proof was made recently by someone who just talked to us.
 *
 * The spec does not say how a nonce is made, how long it lives or whether it is single-use, only
 * that "a nonce shortens the `jti` window; it does not replace `jti`". Ours is stateless, so it
 * works across instances with nothing to store:
 *
 *   nonce = <step>.<HMAC-SHA256(secret, thumbprint, step)>      step = floor(time / window)
 *
 * It is bound to the key it was issued to (a nonce handed to one platform is no use to another)
 * and is accepted during the step it was issued in and the next one. It can be reused inside that
 * time, which is fine: `jti` still makes every proof single-use.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PopNonceOptions {
  /** At least 16 bytes, the same on every instance. */
  secret: string | Uint8Array;
  /** How long one step is; a nonce lives one to two steps. Default 300 seconds. */
  windowSeconds?: number;
}

export interface PopNonces {
  /** A fresh nonce for the key with this thumbprint. */
  issue(jkt: string, now: Date): string;
  /** True if `value` is a nonce this business issued to this key recently. */
  check(value: unknown, jkt: string, now: Date): boolean;
}

const FORMAT = /^(\d{1,12})\.([A-Za-z0-9_-]{22})$/;

export function createPopNonces(options: PopNonceOptions): PopNonces {
  const secret = typeof options.secret === 'string' ? Buffer.from(options.secret) : options.secret;
  if (secret.length < 16) {
    throw new Error('The nonce secret must be at least 16 bytes.');
  }
  const window = options.windowSeconds ?? 300;
  if (!Number.isInteger(window) || window < 10) {
    throw new Error('windowSeconds must be a whole number of at least 10.');
  }
  const stepOf = (now: Date) => Math.floor(now.getTime() / 1000 / window);
  const mac = (jkt: string, step: number) =>
    createHmac('sha256', secret)
      .update(`usp-pop-nonce\n${jkt}\n${step}`)
      .digest('base64url')
      .slice(0, 22);

  return {
    issue: (jkt, now) => {
      const step = stepOf(now);
      return `${step}.${mac(jkt, step)}`;
    },
    check: (value, jkt, now) => {
      const m = typeof value === 'string' ? FORMAT.exec(value) : null;
      if (!m) return false;
      const step = Number(m[1]);
      const current = stepOf(now);
      if (step !== current && step !== current - 1) return false;
      const given = Buffer.from(m[2]!);
      const expected = Buffer.from(mac(jkt, step));
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
