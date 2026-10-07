# @openbooking-sh/hosted

## 0.5.0

### Minor Changes

- b375ced: Removes the marketing-site visitor tools: the `/api/visit` Slack beacon and the `TRACKER_JS` click/scroll tracker (no longer exported). They were for watching openbooking.sh, not part of hosting. Owner pages keep the plain cookieless PostHog snippet, sign-up source and setup-step events.

## 0.4.1

### Patch Changes

- 7d25791: Visitor messages treat the deployment's own domain as home instead of openbooking.sh, so self-hosted sites don't list themselves as the referrer.

## 0.4.0

### Minor Changes

- 6e7ca09: Visitor messages in Slack now include the source and campaign, and a second message when the visitor leaves a page: time on page, how far they read, sections seen and what they clicked. The tracker keeps that journey in memory (`window.__obJourney`); the beacon snippet is in docs/HOSTED.md.

## 0.3.0

### Minor Changes

- 17bf1ca: Better analytics on owner pages (still cookieless, nothing personal): visits carry referrer, `utm_*`, `from` and landing page; named events for sign-up CTA clicks, outbound links, copies, FAQ opens, sections viewed, scroll depth and setup steps; heatmaps on. Sign-ups record their `source` (the website button, campaign or referring site), shown in `business_signed_up` and the Slack message. `TRACKER_JS` is exported for other sites.

## 0.2.0

### Minor Changes

- 4d9f0fc: Better for agents and safer in public, from a fresh-eyes test of the SDK:

  - New MCP tool `get_business_info`: services, staff, opening hours and booking window.
  - Search: ask for a staff member by name with `staff` (any capitalisation, also in `preferences`/`tags`). Unknown names fail with the valid choices instead of returning nothing. Slots list `also_available` staff, and holds and bookings say who is booked. Searching a closed day says so.
  - `party_size` defaults to 1, search returns 20 slots by default, and tool descriptions fit appointments as well as tables.
  - New holds are limited per caller IP (default 20 per 10 minutes; `holdLimit` to tune). Core exports `RateLimiter`, `MemoryRateLimiter` and `clientIpFromHeaders`; actors carry `ip`.
  - Providers can expose opening hours with `getVenueInfo`.

### Patch Changes

- Updated dependencies [4d9f0fc]
  - @openbooking-sh/core@0.2.0
  - @openbooking-sh/provider-memory@0.2.0
  - @openbooking-sh/adapter-mcp@0.2.0
  - @openbooking-sh/server@0.2.0
  - @openbooking-sh/studio@0.2.0
  - @openbooking-sh/booking-page@0.2.0
  - @openbooking-sh/google-calendar@0.2.0
  - @openbooking-sh/notifications@0.2.0

## 0.1.1

### Patch Changes

- 77a3ffa: Business, service and staff ids from names with å, æ, ø or accents are now clean: "Bjørn & Åse Frisør" becomes `bjorn-ase-frisor` (was `bjorn-a-se-frisor`). Existing ids don't change.
- Updated dependencies [77a3ffa]
  - @openbooking-sh/studio@0.1.1
