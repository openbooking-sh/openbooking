import type { GoogleTokens } from '@openbooking-sh/google-calendar';
import type { BusinessSettings } from '@openbooking-sh/studio';

/** One business on hosted OpenBooking. */
export interface Business {
  /**
   * URL name and agent-facing `business_id`, e.g. `studio-nord`. Chosen at sign-up and never
   * changed: it is in every shared link. Also the venue id of its bookings.
   */
  id: string;
  owner: {
    email: string;
    password_hash: string;
    /** Set once the owner clicked the link in the verification (or password reset) email. */
    email_verified_at?: string;
    /** Bumped on password reset; session tokens from an older epoch stop working. */
    session_epoch?: number;
  };
  settings: BusinessSettings;
  google?: {
    tokens: GoogleTokens;
    /** Set when Google stopped accepting the connection; cleared on reconnect. */
    error?: string;
  };
  created_at: string;
  updated_at: string;
  /** Bumped on every settings change; tenants rebuild their catalog when it moves. */
  version: number;
}

export class BusinessConflictError extends Error {
  constructor(readonly field: 'id' | 'email') {
    super(field === 'id' ? 'That business name is taken.' : 'That email already has an account.');
    this.name = 'BusinessConflictError';
  }
}

/**
 * Where businesses live. Memory by default; a Postgres implementation is one table with the
 * record as JSON plus unique indexes on `id` and lower(`owner.email`).
 */
export interface BusinessStore {
  /** Throws {@link BusinessConflictError} if the id or owner email is taken. */
  create(business: Business): Promise<void>;
  get(id: string): Promise<Business | undefined>;
  /** Case-insensitive. */
  getByEmail(email: string): Promise<Business | undefined>;
  /** Atomic read-modify-write. Resolves undefined when the business doesn't exist. */
  update(id: string, fn: (business: Business) => Business): Promise<Business | undefined>;
  list(): Promise<Business[]>;
  /** Remove the account record. Resolves false when there was none. Optional: needed to close accounts. */
  delete?(id: string): Promise<boolean>;
}

export class MemoryBusinessStore implements BusinessStore {
  readonly #byId = new Map<string, Business>();

  async create(business: Business) {
    if (this.#byId.has(business.id)) throw new BusinessConflictError('id');
    if (await this.getByEmail(business.owner.email)) throw new BusinessConflictError('email');
    this.#byId.set(business.id, structuredClone(business));
  }

  async get(id: string) {
    const b = this.#byId.get(id);
    return b ? structuredClone(b) : undefined;
  }

  async getByEmail(email: string) {
    const e = email.toLowerCase();
    for (const b of this.#byId.values()) {
      if (b.owner.email.toLowerCase() === e) return structuredClone(b);
    }
    return undefined;
  }

  async update(id: string, fn: (business: Business) => Business) {
    const b = this.#byId.get(id);
    if (!b) return undefined;
    const next = fn(structuredClone(b));
    this.#byId.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async list() {
    return [...this.#byId.values()].map((b) => structuredClone(b));
  }

  async delete(id: string) {
    return this.#byId.delete(id);
  }
}

/** `Studio Nord!` → `studio-nord`. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      // Norwegian letters before NFKD, which would split å into a + ring.
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'a')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'business'
  );
}

/** Ids that would collide with hosted routes or read as official. */
export const RESERVED_IDS = new Set([
  'api',
  'admin',
  'app',
  'b',
  'book',
  'help',
  'login',
  'mcp',
  'oauth',
  'openbooking',
  'signup',
  'studio',
  'support',
  'www',
]);

/** Can customers and agents book this business yet? */
export function isBookable(b: Business): boolean {
  const s = b.settings;
  return (
    s.services.length > 0 &&
    s.staff.length > 0 &&
    Object.values(s.opening_hours).some((periods) => periods.length > 0)
  );
}

/** Shown in the OpenBooking app (find_business): listed, bookable and, if required, verified. */
export function isListable(b: Business, requireVerifiedEmail: boolean): boolean {
  return (
    b.settings.listed && isBookable(b) && (!requireVerifiedEmail || !!b.owner.email_verified_at)
  );
}
