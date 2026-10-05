/**
 * Operator notifications for hosted OpenBooking: the moments worth knowing about right away
 * (a new business signed up, confirmed its email, got a booking). Posted to a Slack channel
 * through an incoming webhook.
 *
 * Messages name the business, never the customer: no customer names, emails or phone numbers.
 */
export interface OpsNotifier {
  notify(text: string): void;
  /** Resolves when everything posted so far has been sent. */
  flush(): Promise<void>;
}

export class SlackNotifier implements OpsNotifier {
  readonly #webhookUrl: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #prefix: string;
  readonly #pending = new Set<Promise<void>>();

  /**
   * @param webhookUrl Slack incoming webhook (https://hooks.slack.com/services/...). Secret.
   * @param prefix Prepended to every message, e.g. "[staging]".
   */
  constructor(webhookUrl: string, options: { fetch?: typeof fetch; prefix?: string } = {}) {
    this.#webhookUrl = webhookUrl;
    this.#fetch = options.fetch;
    this.#prefix = options.prefix ? `${options.prefix} ` : '';
  }

  notify(text: string): void {
    const doFetch = this.#fetch ?? fetch;
    const p = doFetch(this.#webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: this.#prefix + text, unfurl_links: false }),
    }).then(
      (res) => {
        if (!res.ok) console.warn(`[openbooking] Slack webhook answered ${res.status}`);
      },
      (e: unknown) => console.warn('[openbooking] Slack notification failed', e),
    );
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}

/** Slack mrkdwn needs &, < and > escaped in user-supplied text such as business names. */
export const slackEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
