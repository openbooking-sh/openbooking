/**
 * Server-side HTML for the booking page and the manage page. Every dynamic value is HTML-escaped
 * (business names and descriptions are user-entered); data for the client script is injected as
 * JSON with `<` escaped so it can never close the script element.
 */
import type { Offering, Venue } from '@openbooking-sh/core';
import { MANAGE_SCRIPT, PAGE_SCRIPT } from './client';

export interface PageProfile {
  /** e.g. 'hair_salon' | 'barber' | 'physiotherapist' | 'therapist' | 'personal_trainer' | 'tutor', or free text. */
  category?: string;
  email?: string;
  website?: string;
}

export interface StaffOption {
  id: string;
  name: string;
}

/** Validated pre-fill values from the page URL (see {@link readPrefill}). */
export interface Prefill {
  service?: string;
  staff?: string;
  date?: string;
  time?: string;
  party?: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
}

export interface PageModel {
  venue: Venue;
  offerings: Offering[];
  staff: StaffOption[];
  /** Ask for the number of guests (tables, group classes). */
  showParty: boolean;
  profile: PageProfile;
  pageUrl: string;
  /** Path prefix of the booking-page router, e.g. `/b/studio-nord/book`. */
  apiPath: string;
  mcpUrl?: string;
  prefill: Prefill;
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** JSON safe to embed inside a `<script>` element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/**
 * Pre-fill query parameters (all optional; invalid values are ignored):
 *   service=<offering id>  staff=<staff id>  date=YYYY-MM-DD  time=HH:MM  party=<1-50>
 *   first_name, last_name, email, phone
 * A pre-filled time is highlighted, never held automatically (link previews must not reserve).
 */
export function readPrefill(
  query: Record<string, string | undefined>,
  model: { offerings: Offering[]; staff: StaffOption[] },
): Prefill {
  const out: Prefill = {};
  const text = (v: string | undefined, max = 100) => {
    const t = v?.trim();
    return t && t.length <= max ? t : undefined;
  };
  if (query.service && model.offerings.some((o) => o.id === query.service)) {
    out.service = query.service;
  }
  if (query.staff && model.staff.some((s) => s.id === query.staff)) out.staff = query.staff;
  if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date) && !isNaN(Date.parse(query.date))) {
    out.date = query.date;
  }
  if (query.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(query.time)) out.time = query.time;
  const party = Number(query.party);
  if (Number.isInteger(party) && party >= 1 && party <= 50) out.party = party;
  const first = text(query.first_name);
  const last = text(query.last_name);
  const email = text(query.email, 200);
  const phone = text(query.phone, 30);
  if (first) out.first_name = first;
  if (last) out.last_name = last;
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.email = email;
  if (phone && /^\+?[0-9 ()-]{6,20}$/.test(phone)) out.phone = phone;
  return out;
}

const SCHEMA_TYPES: Record<string, string> = {
  hair_salon: 'HairSalon',
  barber: 'HairSalon',
  beauty_salon: 'BeautySalon',
  nail_salon: 'NailSalon',
  spa: 'DaySpa',
  massage: 'DaySpa',
  physiotherapist: 'Physiotherapy',
  therapist: 'MedicalBusiness',
  personal_trainer: 'HealthClub',
  restaurant: 'Restaurant',
};

export function jsonLd(m: PageModel): Record<string, unknown> {
  const v = m.venue;
  const a = v.address;
  return {
    '@context': 'https://schema.org',
    '@type': SCHEMA_TYPES[m.profile.category ?? ''] ?? 'LocalBusiness',
    name: v.name,
    ...(v.description ? { description: v.description } : {}),
    url: m.pageUrl,
    ...(v.phone_number ? { telephone: v.phone_number } : {}),
    ...(m.profile.email ? { email: m.profile.email } : {}),
    ...(m.profile.website ? { sameAs: [m.profile.website] } : {}),
    ...(a
      ? {
          address: {
            '@type': 'PostalAddress',
            ...(a.street_address ? { streetAddress: a.street_address } : {}),
            ...(a.address_locality ? { addressLocality: a.address_locality } : {}),
            ...(a.address_region ? { addressRegion: a.address_region } : {}),
            ...(a.postal_code ? { postalCode: a.postal_code } : {}),
            ...(a.address_country ? { addressCountry: a.address_country } : {}),
          },
        }
      : {}),
    makesOffer: m.offerings.map((o) => ({
      '@type': 'Offer',
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
      url: `${m.pageUrl}?service=${encodeURIComponent(o.id)}`,
      ...(o.price_per_person
        ? {
            price: (o.price_per_person.amount / 100).toFixed(2),
            priceCurrency: o.price_per_person.currency,
          }
        : {}),
    })),
    potentialAction: {
      '@type': 'ReserveAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${m.pageUrl}?service={service}&date={date}&time={time}`,
        actionPlatform: [
          'http://schema.org/DesktopWebPlatform',
          'http://schema.org/MobileWebPlatform',
        ],
      },
      result: { '@type': 'Reservation', name: `Appointment at ${v.name}` },
    },
  };
}

function addressLine(v: Venue): string {
  const a = v.address;
  if (!a) return '';
  return [a.street_address, [a.postal_code, a.address_locality].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

const STYLE = `
  :root {
    --bg: #f8f8f5; --bg-2: #f1f1ec; --card: #fff; --ink: #0b1020; --ink-2: #4a5068; --ink-3: #8a90a3;
    --line: rgba(11,16,32,.08); --line-2: rgba(11,16,32,.14); --royal: #2747e8; --royal-2: #1b34c4;
    --sky-bg: #eaf3ff; --green: #16a34a; --green-bg: #e8f7ee; --amber: #b45309; --amber-bg: #fdf3e2;
    --red: #dc2626; --red-bg: #fdecec; --mono: 'Geist Mono', ui-monospace, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d14; --bg-2: #151924; --card: #12151f; --ink: #eef0f6; --ink-2: #b3b8c9; --ink-3: #7d8397;
      --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.16); --royal: #5b78ff; --royal-2: #7690ff;
      --sky-bg: #1a2240; --green: #4ade80; --green-bg: #12301f; --amber: #f5b454; --amber-bg: #33260f;
      --red: #f87171; --red-bg: #3a1616;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.5 Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  button, input, select, textarea { font: inherit; color: inherit; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 28px 16px 64px; }
  header h1 { margin: 0 0 4px; font-size: 26px; font-weight: 500; letter-spacing: -.03em; }
  header p { margin: 2px 0; color: var(--ink-2); }
  header .meta { color: var(--ink-3); font-size: 14px; }
  header .meta a { color: inherit; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; margin-top: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 15px; font-weight: 500; }
  .opt { display: flex; justify-content: space-between; gap: 12px; width: 100%; text-align: left; background: var(--card); border: 1px solid var(--line-2); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer; }
  .opt:hover { border-color: var(--royal); }
  .opt.on { border-color: var(--royal); box-shadow: inset 0 0 0 1px var(--royal); }
  .opt small { display: block; color: var(--ink-3); }
  .opt .p { white-space: nowrap; font-weight: 500; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--line-2); background: var(--card); padding: 6px 12px; border-radius: 99px; cursor: pointer; font-size: 14px; color: var(--ink-2); }
  .chip.on { background: var(--royal); color: #fff; border-color: var(--royal); }
  .chip.hint { border-color: var(--royal); color: var(--royal); }
  .times { display: flex; flex-wrap: wrap; gap: 6px; }
  .times .chip { font-family: var(--mono); }
  .field { display: grid; gap: 5px; margin-bottom: 12px; }
  .field label { font-size: 13px; color: var(--ink-3); }
  .field input, .field textarea { height: 42px; border: 1px solid var(--line-2); border-radius: 10px; padding: 0 12px; background: var(--card); width: 100%; }
  .field textarea { height: 76px; padding: 9px 12px; resize: vertical; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .btn { height: 44px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--line-2); background: var(--card); cursor: pointer; font-weight: 500; }
  .btn-primary { background: var(--royal); border-color: var(--royal); color: #fff; width: 100%; }
  .btn-primary:hover { background: var(--royal-2); }
  .btn-danger { color: var(--red); border-color: var(--red); }
  .btn:disabled { opacity: .6; cursor: default; }
  .kv { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; margin: 0 0 14px; }
  .kv dt { color: var(--ink-3); }
  .kv dd { margin: 0; }
  .note { background: var(--sky-bg); border-radius: 10px; padding: 10px 12px; font-size: 14px; margin: 10px 0; }
  .warn { background: var(--amber-bg); color: var(--amber); border-radius: 10px; padding: 10px 12px; font-size: 14px; margin: 10px 0; }
  .err { color: var(--red); font-size: 14px; min-height: 20px; margin: 6px 0; }
  .muted { color: var(--ink-3); }
  .code { font: 500 22px var(--mono); letter-spacing: .08em; }
  .ok { color: var(--green); }
  .hidden { display: none !important; }
  footer { text-align: center; color: var(--ink-3); font-size: 13px; margin-top: 32px; }
  footer a { color: var(--royal); text-decoration: none; }
  code { font-family: var(--mono); font-size: 13px; word-break: break-all; }
  @media (max-width: 420px) { .two { grid-template-columns: 1fr; } }
`;

function head(title: string, description: string, canonical: string, extra = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${STYLE}</style>
${extra}
</head>`;
}

function venueHeader(v: Venue, profile: PageProfile): string {
  const addr = addressLine(v);
  const meta = [
    addr ? esc(addr) : '',
    v.phone_number
      ? `<a href="tel:${esc(v.phone_number.replace(/[^+0-9]/g, ''))}">${esc(v.phone_number)}</a>`
      : '',
    profile.website
      ? `<a href="${esc(profile.website)}" rel="noopener" target="_blank">Website</a>`
      : '',
  ].filter(Boolean);
  return `<header>
  <h1>${esc(v.name)}</h1>
  ${v.description ? `<p>${esc(v.description)}</p>` : ''}
  ${meta.length ? `<p class="meta">${meta.join(' · ')}</p>` : ''}
</header>`;
}

export function renderPage(m: PageModel): string {
  const v = m.venue;
  const title = `Book ${v.name}`;
  const description =
    v.description ?? `Book an appointment at ${v.name} online. See free times and book instantly.`;
  const data = {
    api_path: m.apiPath,
    page_url: m.pageUrl,
    venue: {
      name: v.name,
      timezone: v.timezone,
      currency: v.currency ?? null,
      phone_number: v.phone_number ?? null,
    },
    offerings: m.offerings.map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description ?? null,
      duration_minutes: o.duration_minutes,
      price: o.price_per_person,
    })),
    staff: m.staff,
    show_party: m.showParty,
    prefill: m.prefill,
  };
  const contact = v.phone_number ? ` on ${esc(v.phone_number)}` : '';
  return `${head(
    title,
    description,
    m.pageUrl,
    `<script type="application/ld+json">${scriptJson(jsonLd(m))}</script>`,
  )}
<body>
<div class="wrap">
${venueHeader(v, m.profile)}
<noscript><div class="warn">Online booking needs JavaScript. Please contact ${esc(v.name)}${contact}.</div></noscript>

<section class="card" id="s-service"><h2>1. Choose a service</h2><div id="services"></div></section>

<section class="card hidden" id="s-when">
  <h2>2. Pick a time</h2>
  <div id="staff-wrap" class="hidden" style="margin-bottom:14px"><div class="muted" style="font-size:13px;margin-bottom:6px">With</div><div class="chips" id="staff"></div></div>
  <div id="party-wrap" class="field hidden" style="max-width:160px"><label for="party">Guests</label><input id="party" type="number" min="1" max="50" value="1" /></div>
  <div class="chips" id="dates"></div>
  <div class="field" style="max-width:200px;margin-top:10px"><label for="date">Or choose a date</label><input id="date" type="date" /></div>
  <div id="times-msg" class="muted"></div>
  <div class="times" id="times"></div>
</section>

<section class="card hidden" id="s-details">
  <h2>3. Your details</h2>
  <div class="note" id="hold-note"></div>
  <dl class="kv" id="review"></dl>
  <div class="two"><div class="field"><label for="first">First name</label><input id="first" autocomplete="given-name" /></div>
  <div class="field"><label for="last">Last name</label><input id="last" autocomplete="family-name" /></div></div>
  <div class="two"><div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" /></div>
  <div class="field"><label for="phone">Phone</label><input id="phone" type="tel" autocomplete="tel" placeholder="+47..." /></div></div>
  <div class="field"><label for="notes">Anything we should know? (optional)</label><textarea id="notes" maxlength="500"></textarea></div>
  <div class="err" id="err"></div>
  <button class="btn btn-primary" id="confirm">Confirm booking</button>
  <p class="muted" style="font-size:13px">By confirming you accept the price and cancellation terms above.</p>
</section>

<section class="card hidden" id="s-done">
  <h2 class="ok">You're booked</h2>
  <p>Confirmation code</p>
  <div class="code" id="done-code"></div>
  <dl class="kv" id="done-review" style="margin-top:14px"></dl>
  <p><a class="btn" id="ics" download="booking.ics" style="display:inline-flex;align-items:center;text-decoration:none">Add to calendar</a></p>
  <p class="muted" style="font-size:14px">Need to change plans? <a id="manage" href="#">Manage or cancel your booking</a>.</p>
</section>

${
  m.mcpUrl
    ? `<section class="card"><h2>Book with an AI assistant</h2><p class="muted" style="margin:0 0 8px;font-size:14px">${esc(v.name)} can be booked from ChatGPT, Claude, Gemini and other assistants. Ask yours to book ${esc(v.name)}, or connect this MCP server:</p><code>${esc(m.mcpUrl)}</code></section>`
    : ''
}
<footer>Bookings by <a href="https://openbooking.sh" target="_blank" rel="noopener">OpenBooking</a></footer>
</div>
<script type="application/json" id="ob-data">${scriptJson(data)}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

export function renderManage(m: {
  venue: Venue;
  profile: PageProfile;
  pageUrl: string;
  apiPath: string;
}): string {
  const v = m.venue;
  const data = { api_path: m.apiPath, page_url: m.pageUrl, venue: { timezone: v.timezone } };
  return `${head(`Your booking · ${v.name}`, `Manage your booking at ${v.name}.`, m.pageUrl, '<meta name="robots" content="noindex" />')}
<body>
<div class="wrap">
${venueHeader(v, m.profile)}
<section class="card">
  <h2>Your booking</h2>
  <div id="body" class="muted">Loading…</div>
  <div class="err" id="err"></div>
  <div id="cancel-box" class="hidden">
    <div class="warn hidden" id="terms"></div>
    <button class="btn btn-danger" id="cancel">Cancel booking</button>
  </div>
</section>
<p style="margin-top:16px"><a href="${esc(m.pageUrl)}" style="color:var(--royal)">Make a new booking</a></p>
<footer>Bookings by <a href="https://openbooking.sh" target="_blank" rel="noopener">OpenBooking</a></footer>
</div>
<script type="application/json" id="ob-data">${scriptJson(data)}</script>
<script>${MANAGE_SCRIPT}</script>
</body>
</html>`;
}
