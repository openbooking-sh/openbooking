import { createHash } from 'node:crypto';

/**
 * The addresses that asked to stop receiving a business's emails. Only a hash is kept, never the
 * address, so the list is no personal-data store of its own and a leak shows no contact details.
 */
export interface SuppressionList {
  /** Idempotent. */
  add(scope: string, hash: string): Promise<void>;
  has(scope: string, hash: string): Promise<boolean>;
  /** Forget everything for one scope (a business closing its account). */
  deleteScope(scope: string): Promise<void>;
}

/**
 * SHA-256 of the normalised address, bound to the business. Deliberately not keyed with a secret:
 * rotating a signing secret must never silently re-enable mail to someone who opted out.
 */
export function suppressionHash(scope: string, email: string): string {
  return createHash('sha256')
    .update(`openbooking:unsubscribe:v1:${scope}:${email.trim().toLowerCase()}`)
    .digest('hex');
}

export class MemorySuppressionList implements SuppressionList {
  readonly #byScope = new Map<string, Set<string>>();

  async add(scope: string, hash: string): Promise<void> {
    const set = this.#byScope.get(scope) ?? new Set<string>();
    set.add(hash);
    this.#byScope.set(scope, set);
  }

  async has(scope: string, hash: string): Promise<boolean> {
    return this.#byScope.get(scope)?.has(hash) ?? false;
  }

  async deleteScope(scope: string): Promise<void> {
    this.#byScope.delete(scope);
  }
}
