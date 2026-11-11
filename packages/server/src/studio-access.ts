/**
 * When Studio may run without a token. Studio shows customer names and contact details, so the
 * open mode is for local development only, and every doubt locks it.
 *
 * A localhost `baseUrl` is not proof of local development: it is also what an app falls back to
 * when BASE_URL was never set on a host. So two more things must hold:
 *
 * 1. At start, nothing says this is a deployment (NODE_ENV=production or a hosting platform's
 *    own environment variable).
 * 2. On each request, the caller is on this machine. The socket address is the only part a caller
 *    cannot forge, so it decides when the runtime gives it to us. Forwarding headers and the Host
 *    are checked on top: a caller can add or change them, but that only ever locks.
 */

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Variables the hosting platforms set themselves. One of them means "this is a deployment". */
const HOSTING_VARIABLES = [
  'VERCEL',
  'RAILWAY_ENVIRONMENT',
  'FLY_APP_NAME',
  'RENDER',
  'DYNO',
  'K_SERVICE',
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_EXECUTION_ENV',
  'NETLIFY',
  'CF_PAGES',
  'WEBSITE_SITE_NAME',
  'KUBERNETES_SERVICE_HOST',
];

/** Headers a reverse proxy or tunnel adds. A request carrying one did not start on this machine. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
];

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.includes(hostname);
}

export type StudioAccess =
  /** Local development: open, and each request is still checked with `isFromThisMachine`. */
  | { open: true }
  /** Locked until a token is set. `reason` is set when a localhost baseUrl was overruled. */
  | { open: false; reason?: string };

export function studioAccessWithoutToken(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): StudioAccess {
  if (!isLocalHostname(new URL(baseUrl).hostname)) return { open: false };
  if (env.NODE_ENV === 'production') return { open: false, reason: 'NODE_ENV is "production"' };
  const hosting = HOSTING_VARIABLES.find((name) => env[name]);
  if (hosting) return { open: false, reason: `${hosting} is set, so this is a deployment` };
  return { open: true };
}

function isLoopback(address: string): boolean {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** `env` is what the runtime hands to `fetch`; on Node (`listen`) it carries the socket. */
export function isFromThisMachine(request: Request, env: unknown): boolean {
  const peer = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    ?.socket?.remoteAddress;
  // No socket means no Node server (an in-process call, another runtime): the checks at start and
  // the ones below still apply.
  if (peer !== undefined && !isLoopback(peer)) return false;
  if (FORWARDING_HEADERS.some((name) => request.headers.has(name))) return false;
  // Also stops a web page from reaching a developer's Studio through DNS rebinding.
  return isLocalHostname(new URL(request.url).hostname);
}
