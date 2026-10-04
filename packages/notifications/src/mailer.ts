export interface EmailAttachment {
  filename: string;
  /** UTF-8 text, e.g. an .ics calendar file. */
  content: string;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: EmailAttachment[];
}

/** Sends one email. Throw on failure; callers decide whether to retry or log. */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** Development mailer: prints each email to the console instead of sending it. */
export class ConsoleMailer implements Mailer {
  async send(m: EmailMessage): Promise<void> {
    const files = m.attachments?.length
      ? ` [${m.attachments.map((a) => a.filename).join(', ')}]`
      : '';
    console.log(`[email] to ${m.to}: ${m.subject}${files}\n${m.text}\n`);
  }
}

/** Keeps every email in `sent`. For tests and demos. */
export class MemoryMailer implements Mailer {
  readonly sent: EmailMessage[] = [];

  async send(m: EmailMessage): Promise<void> {
    this.sent.push(structuredClone(m));
  }
}

export interface ResendMailerOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Default https://api.resend.com/emails */
  endpoint?: string;
}

/** Sends through the Resend HTTP API (works on serverless, no SMTP needed). */
export class ResendMailer implements Mailer {
  readonly #opts: ResendMailerOptions;

  constructor(options: ResendMailerOptions) {
    this.#opts = options;
  }

  async send(m: EmailMessage): Promise<void> {
    const doFetch = this.#opts.fetch ?? fetch;
    const res = await doFetch(this.#opts.endpoint ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: m.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        html: m.html,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        ...(m.attachments?.length
          ? {
              attachments: m.attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content, 'utf8').toString('base64'),
                content_type: a.contentType,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend responded ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}

/** Dedupe for notifications, so a retried confirm never emails twice. */
export interface NotificationLog {
  /** True the first time `key` is claimed, false afterwards. Must be atomic. */
  claim(key: string): Promise<boolean>;
}

export class MemoryNotificationLog implements NotificationLog {
  readonly #keys = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    return true;
  }
}
