/**
 * Google OAuth 2.0 (web server flow) for Calendar access, on plain fetch.
 * https://developers.google.com/identity/protocols/oauth2/web-server
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Read busy times, write booking events, list calendars (to pick one per staff member). */
export const GOOGLE_SCOPES: string[] = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  /** When the access token expires, epoch ms. */
  expires_at: number;
  scope?: string;
  /** The connected Google account. */
  email?: string;
}

/** Where a business's Google tokens live (e.g. its settings record). */
export interface GoogleTokenStore {
  get(): Promise<GoogleTokens | undefined>;
  set(tokens: GoogleTokens): Promise<void>;
}

/** The connection is gone (revoked, expired or never made): the business must reconnect. */
export class GoogleAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GoogleAuthError';
  }
}

/** Google answered with an error (or a calendar in a freeBusy answer had errors). */
export class GoogleApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

/** The consent screen URL. `state` comes back on the redirect; make it unguessable and signed. */
export function googleAuthUrl(
  creds: GoogleCredentials,
  opts: { state: string; loginHint?: string },
): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Always ask, so Google returns a refresh token even on a reconnect.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: opts.state,
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  fetchFn: typeof fetch,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant') {
      throw new GoogleAuthError(
        `Google refused the grant: ${json.error_description ?? 'invalid_grant'}`,
      );
    }
    throw new GoogleApiError(
      res.status,
      `Google token request failed: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  return json;
}

/** Email claim of an ID token. */
function emailOf(idToken: string | undefined): string | undefined {
  // No signature check needed: the token came straight from Google's token endpoint over TLS,
  // not from a client, so its payload is as trustworthy as the response itself.
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/** Swap the `code` from the OAuth redirect for tokens. */
export async function exchangeCode(
  creds: GoogleCredentials,
  code: string,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<GoogleTokens> {
  const fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const json = await tokenRequest(fetchFn, {
    grant_type: 'authorization_code',
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
  });
  if (!json.refresh_token) {
    throw new GoogleAuthError('Google returned no refresh token. Connect the calendar again.');
  }
  const email = emailOf(json.id_token);
  return {
    access_token: json.access_token!,
    refresh_token: json.refresh_token,
    expires_at: now() + (json.expires_in ?? 3600) * 1000,
    ...(json.scope ? { scope: json.scope } : {}),
    ...(email ? { email } : {}),
  };
}

/** New access token for a refresh token. Keeps the old refresh token unless Google rotates it. */
export async function refreshTokens(
  creds: GoogleCredentials,
  tokens: GoogleTokens,
  fetchFn: typeof fetch,
  now: () => number,
): Promise<GoogleTokens> {
  const json = await tokenRequest(fetchFn, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  return {
    ...tokens,
    access_token: json.access_token!,
    refresh_token: json.refresh_token ?? tokens.refresh_token,
    expires_at: now() + (json.expires_in ?? 3600) * 1000,
    ...(json.scope ? { scope: json.scope } : {}),
  };
}
