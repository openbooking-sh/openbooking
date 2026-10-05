/**
 * One business at runtime: its provider (catalog from settings, bookings in the shared store),
 * BookingService, protocol app (MCP, UCP, A2A, booking page), Studio, emails and Google sync.
 */
import {
  BookingError,
  BookingService,
  type AvailabilityQuery,
  type Booking,
  type BookingEvent,
  type BookingProvider,
  type CancelBookingRequest,
  type Clock,
  type ConfirmHoldRequest,
  type CreateHoldRequest,
  type IdempotencyRecord,
  type IdempotencyStore,
  type ProviderContext,
  type UpdateBookingRequest,
} from '@openbooking-sh/core';
import {
  GoogleCalendarClient,
  attachCalendarSync,
  googleBusySource,
  type CalendarLinkStore,
  type CalendarSync,
  type CalendarSyncConfig,
  type GoogleCredentials,
} from '@openbooking-sh/google-calendar';
import {
  attachNotifications,
  type Mailer,
  type NotificationHandle,
  type NotificationLog,
} from '@openbooking-sh/notifications';
import {
  MemoryBookingProvider,
  type BookingListQuery,
  type BookingRecordStore,
  type BusySource,
} from '@openbooking-sh/provider-memory';
import { createOpenBookingApp, type OpenBookingApp } from '@openbooking-sh/server';
import {
  createStudio,
  type ActivityLog,
  type BusinessSettings,
  type SettingsView,
  type Studio,
} from '@openbooking-sh/studio';
import type { Business, BusinessStore } from './business';
import { providerConfig } from './catalog';

export interface TenantDeps {
  baseUrl: string;
  businesses: BusinessStore;
  bookings: BookingRecordStore;
  idempotency: IdempotencyStore;
  activityFor: (businessId: string) => ActivityLog;
  clock?: Clock;
  holdTtlSeconds?: number;
  mail?: { mailer: Mailer; from: string };
  notificationLog: NotificationLog;
  google?: GoogleCredentials & { fetch?: typeof fetch };
  calendarLinks: CalendarLinkStore;
  allowedHosts: string[];
  /** Owners must confirm their email before the business is listed in the OpenBooking app. */
  requireVerifiedEmail?: boolean;
  onEvent?: (businessId: string, event: BookingEvent) => void;
}

export const GOOGLE_RECONNECT =
  'Google Calendar stopped accepting the connection. Reconnect it to keep your calendar in sync.';

export class Tenant {
  readonly id: string;
  readonly provider: TenantProvider;
  readonly service: BookingService;
  readonly studio: Studio;
  #business: Business;
  #app: OpenBookingApp;
  #appVersion: number;
  #notifications: NotificationHandle | undefined;
  #google: { key: string; client: GoogleCalendarClient; sync: CalendarSync } | undefined;
  #googleBusy: BusySource | undefined;
  readonly #deps: TenantDeps;

  constructor(business: Business, deps: TenantDeps) {
    this.id = business.id;
    this.#business = business;
    this.#deps = deps;
    this.provider = new TenantProvider(business, deps.bookings, this.pageUrl, (q) =>
      this.#googleBusy ? this.#googleBusy(q) : Promise.resolve([]),
    );
    this.service = new BookingService({
      provider: this.provider,
      idempotencyStore: prefixed(deps.idempotency, `${business.id}:`),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.holdTtlSeconds ? { holdTtlSeconds: deps.holdTtlSeconds } : {}),
      ...(deps.onEvent ? { onEvent: (e) => deps.onEvent!(this.id, e) } : {}),
    });
    this.#app = this.#createApp();
    this.#appVersion = business.version;
    // Hosted authenticates owners before any request reaches this Studio (see app.ts).
    this.studio = createStudio({
      service: this.service,
      activity: deps.activityFor(business.id),
      insecureNoAuth: true,
      settings: { get: () => this.settingsView(), update: (s) => this.#saveSettings(s) },
    });
    if (deps.mail) {
      const { mailer, from } = deps.mail;
      this.#notifications = attachNotifications({
        service: this.service,
        mailer,
        log: deps.notificationLog,
        config: () => {
          const s = this.#business.settings;
          const owner = s.notifications.owner_email ?? this.#business.owner.email;
          return {
            from: `${s.profile.name.replace(/[<>"]/g, '')} <${from}>`,
            replyTo: s.profile.email ?? this.#business.owner.email,
            ownerEmail: owner,
            ownerEmails: s.notifications.email_owner,
            customerEmails: s.notifications.email_customers,
          };
        },
        manageUrl: (b) => this.#app.bookingPage?.manageUrl(b),
      });
    }
    this.#setupGoogle();
  }

  get business(): Business {
    return this.#business;
  }

  get pageUrl(): string {
    return `${this.#deps.baseUrl}/b/${this.id}`;
  }

  /** The protocol app, mounted at `/b/<id>`: MCP, UCP, A2A card and the booking page. */
  get app(): OpenBookingApp['app'] {
    return this.#app.app;
  }

  /** Bring the runtime in line with the stored business (settings, Google connection). */
  sync(business: Business): void {
    this.#business = business;
    if (business.version !== this.#appVersion) {
      this.provider.rebuild(business);
      const old = this.#app;
      this.#app = this.#createApp();
      this.#appVersion = business.version;
      void old.close();
    }
    this.#setupGoogle();
  }

  /** The Google client while connected (calendar list for Studio). */
  get google(): GoogleCalendarClient | undefined {
    return this.#google?.client;
  }

  async settingsView(): Promise<SettingsView> {
    const b = this.#business;
    const name = b.settings.profile.name;
    const ask = encodeURIComponent(`I'd like to book an appointment at ${name}: ${this.pageUrl}`);
    const google = this.#deps.google;
    const connected = !!b.google && !b.google.error;
    const calendars = connected
      ? await this.google?.listCalendars().catch(() => undefined)
      : undefined;
    return {
      settings: b.settings,
      links: [
        { label: 'Booking page', url: this.pageUrl, hint: 'customers and AI assistants book here' },
        { label: 'Book me through ChatGPT', url: `https://chatgpt.com/?q=${ask}` },
        { label: 'Book me through Claude', url: `https://claude.ai/new?q=${ask}` },
        { label: 'MCP server', url: `${this.pageUrl}/mcp`, hint: 'for AI apps and developers' },
      ],
      integrations: {
        google: {
          available: !!google,
          connected,
          ...(b.google?.tokens.email ? { email: b.google.tokens.email } : {}),
          ...(b.google?.error ? { error: b.google.error } : {}),
          ...(calendars
            ? { calendars: calendars.map(({ id, summary, primary }) => ({ id, summary, primary })) }
            : {}),
          connect_path: '/integrations/google/connect',
          disconnect_path: '/integrations/google/disconnect',
        },
      },
      install: {
        booking_page: this.pageUrl,
        snippet: `<script src="${this.pageUrl}/embed.js" async></script>`,
      },
      account: {
        email: b.owner.email,
        ...(this.#deps.requireVerifiedEmail
          ? {
              email_verified: !!b.owner.email_verified_at,
              resend_verification_path: '/account/verify-email',
            }
          : {}),
      },
    };
  }

  async #saveSettings(settings: BusinessSettings): Promise<SettingsView> {
    const now = new Date().toISOString();
    const saved = await this.#deps.businesses.update(this.id, (b) => ({
      ...b,
      settings,
      version: b.version + 1,
      updated_at: now,
    }));
    if (!saved) throw new BookingError('not_found', 'This business no longer exists.');
    this.sync(saved);
    return this.settingsView();
  }

  #setupGoogle(): void {
    const creds = this.#deps.google;
    const g = this.#business.google;
    const key = creds && g && !g.error ? g.tokens.refresh_token : '';
    if (key === (this.#google?.key ?? '')) return;
    this.#google?.sync.detach();
    this.#google = undefined;
    this.#googleBusy = undefined;
    if (!key || !creds) return;

    const { businesses } = this.#deps;
    const id = this.id;
    const client = new GoogleCalendarClient({
      credentials: creds,
      ...(creds.fetch ? { fetch: creds.fetch } : {}),
      ...(this.#deps.clock ? { now: () => this.#deps.clock!.now().getTime() } : {}),
      tokens: {
        get: async () => (await businesses.get(id))?.google?.tokens,
        // Token refreshes are not settings changes: no version bump.
        set: async (tokens) =>
          void (await businesses.update(id, (b) =>
            b.google ? { ...b, google: { ...b.google, tokens } } : b,
          )),
      },
    });
    const config = (): CalendarSyncConfig => ({
      defaultCalendarId: 'primary',
      staffCalendars: Object.fromEntries(
        this.#business.settings.staff
          .filter((m) => m.google_calendar_id)
          .map((m) => [m.id, m.google_calendar_id!]),
      ),
    });
    const onAuthError = () => {
      void businesses
        .update(id, (b) =>
          b.google ? { ...b, google: { ...b.google, error: GOOGLE_RECONNECT } } : b,
        )
        .then((b) => b && this.sync(b));
    };
    this.#googleBusy = googleBusySource({ client, config, onAuthError });
    const sync = attachCalendarSync({
      service: this.service,
      client,
      config,
      links: this.#deps.calendarLinks,
      onAuthError,
    });
    this.#google = { key, client, sync };
  }

  #createApp(): OpenBookingApp {
    const b = this.#business;
    return createOpenBookingApp({
      service: this.service,
      baseUrl: this.pageUrl,
      name: b.settings.profile.name,
      ...(b.settings.profile.description ? { description: b.settings.profile.description } : {}),
      organization: { organization: 'OpenBooking', url: 'https://openbooking.sh' },
      allowedHosts: this.#deps.allowedHosts,
      studio: false,
      bookingPage: {
        pageUrl: this.pageUrl,
        profile: () => {
          const p = this.#business.settings.profile;
          return {
            category: p.category,
            ...(p.email ? { email: p.email } : {}),
            ...(p.website ? { website: p.website } : {}),
          };
        },
      },
    });
  }

  /** Wait for background work (activity, emails, calendar sync). */
  async idle(): Promise<void> {
    await Promise.all([this.studio.idle(), this.#notifications?.idle(), this.#google?.sync.idle()]);
  }

  async close(): Promise<void> {
    await this.idle();
    this.studio.close();
    this.#notifications?.detach();
    this.#google?.sync.detach();
    await this.#app.close();
  }
}

/**
 * The business's catalog over the shared booking store. Every booking it reads or changes must be
 * its own: the store holds every business's bookings.
 */
export class TenantProvider implements BookingProvider {
  #inner: MemoryBookingProvider;
  #business: Business;
  readonly #store: BookingRecordStore;
  readonly #pageUrl: string;
  readonly #busy: BusySource;

  constructor(business: Business, store: BookingRecordStore, pageUrl: string, busy: BusySource) {
    this.#business = business;
    this.#store = store;
    this.#pageUrl = pageUrl;
    this.#busy = busy;
    this.#inner = this.#build();
  }

  get info() {
    const p = this.#business.settings.profile;
    return { name: p.name, ...(p.description ? { description: p.description } : {}) };
  }

  rebuild(business: Business): void {
    this.#business = business;
    this.#inner = this.#build();
  }

  #build(): MemoryBookingProvider {
    return new MemoryBookingProvider(providerConfig(this.#business, this.#pageUrl), {
      store: this.#store,
      busy: this.#busy,
    });
  }

  listVenues() {
    return this.#inner.listVenues();
  }

  async searchAvailability(query: AvailabilityQuery & { venue_id: string }, ctx: ProviderContext) {
    // Nothing to book until the owner adds staff (the engine needs someone to do the work).
    if (!this.#business.settings.staff.length) return [];
    return this.#inner.searchAvailability(query, ctx);
  }

  createHold(req: CreateHoldRequest, ctx: ProviderContext) {
    return this.#inner.createHold(req, ctx);
  }

  async confirmHold(req: ConfirmHoldRequest, ctx: ProviderContext) {
    await this.#own(req.booking_id, ctx);
    return this.#inner.confirmHold(req, ctx);
  }

  async getBooking(bookingId: string, ctx: ProviderContext): Promise<Booking | null> {
    const b = await this.#inner.getBooking(bookingId, ctx);
    return b && b.venue_id === this.#business.id ? b : null;
  }

  async updateBooking(req: UpdateBookingRequest, ctx: ProviderContext) {
    await this.#own(req.booking_id, ctx);
    return this.#inner.updateBooking(req, ctx);
  }

  async cancelBooking(req: CancelBookingRequest, ctx: ProviderContext) {
    await this.#own(req.booking_id, ctx);
    return this.#inner.cancelBooking(req, ctx);
  }

  listOfferings(venueId: string) {
    return this.#inner.listOfferings(venueId);
  }

  listResources(venueId: string) {
    return this.#inner.listResources(venueId);
  }

  async listBookings(query: BookingListQuery, ctx: ProviderContext) {
    const id = this.#business.id;
    // Filter again in case a store ignores venue_id.
    return (await this.#inner.listBookings({ ...query, venue_id: id }, ctx)).filter(
      (b) => b.venue_id === id,
    );
  }

  async #own(bookingId: string, ctx: ProviderContext) {
    if (!(await this.getBooking(bookingId, ctx))) {
      throw new BookingError('not_found', `No booking with id "${bookingId}".`);
    }
  }
}

/** Idempotency keys are per business: the same key at two businesses is two different calls. */
function prefixed(store: IdempotencyStore, prefix: string): IdempotencyStore {
  return {
    get: (key) => store.get(prefix + key),
    set: (key, record: IdempotencyRecord, ttlMs) => store.set(prefix + key, record, ttlMs),
  };
}
