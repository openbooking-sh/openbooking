/**
 * Product analytics for hosted OpenBooking: how businesses sign up, set up and get booked.
 *
 * Events are keyed by business id only. Never pass names, emails, phone numbers or booking
 * notes as properties: analytics should answer "how many AI bookings did businesses get this
 * week", not "who booked".
 */
export interface Analytics {
  capture(event: string, businessId: string, properties?: Record<string, unknown>): void;
  /** Resolves when everything captured so far has been sent. */
  flush(): Promise<void>;
}

export interface PostHogOptions {
  /** Project API key (`phc_...`). Public by design; safe in page HTML too. */
  apiKey: string;
  /** EU cloud by default, so data stays in the EU. */
  host?: string;
  fetch?: typeof fetch;
}

/** Sends events to PostHog's capture API with plain fetch (no SDK, fine on serverless). */
export class PostHogAnalytics implements Analytics {
  readonly #opts: Required<Omit<PostHogOptions, 'fetch'>> & { fetch?: typeof fetch };
  readonly #pending = new Set<Promise<void>>();

  constructor(options: PostHogOptions) {
    this.#opts = { host: 'https://eu.i.posthog.com', ...options };
  }

  capture(event: string, businessId: string, properties: Record<string, unknown> = {}): void {
    const doFetch = this.#opts.fetch ?? fetch;
    const p = doFetch(`${this.#opts.host.replace(/\/+$/, '')}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.#opts.apiKey,
        event,
        distinct_id: `business:${businessId}`,
        timestamp: new Date().toISOString(),
        properties: {
          ...properties,
          business_id: businessId,
          $groups: { business: businessId },
          // Server-side events: no person profile, no IP-based geolocation.
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
    }).then(
      () => undefined,
      (e: unknown) => console.warn('[openbooking] analytics capture failed', e),
    );
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}

/**
 * The PostHog browser snippet for owner-facing pages (sign-up, setup, Studio). Cookieless: no
 * cookies or local storage, so no consent banner is needed. Turn on "Cookieless server hash mode"
 * in the PostHog project settings for unique-visitor counts.
 */
export function posthogSnippet(apiKey: string, host = 'https://eu.i.posthog.com'): string {
  const cfg = JSON.stringify({ key: apiKey, host }).replace(/</g, '\\u003c');
  return `<script>
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
(function(){var c=${cfg};posthog.init(c.key,{api_host:c.host,cookieless_mode:'always',person_profiles:'identified_only',capture_pageview:true,capture_pageleave:true,disable_session_recording:true});})();
</script>`;
}

/** Insert `snippet` before `</head>`. */
export function withHeadSnippet(html: string, snippet: string | undefined): string {
  return snippet ? html.replace('</head>', `${snippet}\n</head>`) : html;
}
