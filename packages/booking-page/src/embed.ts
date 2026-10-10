/**
 * `embed.js`: one line a business pastes into its own website (Wix, Squarespace, WordPress,
 * Webflow, Shopify, plain HTML):
 *
 *   <script src="https://app.openbooking.sh/b/studio-nord/embed.js" async></script>
 *
 * It adds a "Book" button that opens the booking page in a popup, turns links to the booking page
 * (and elements with `data-openbooking`) into popup triggers, adds schema.org data about the
 * business, and registers the booking tools for browser agents (WebMCP) on the business's own
 * site. Options go on the script tag:
 *
 *   data-label="Book a time"   button text (default "Book now")
 *   data-color="#111827"       button colour
 *   data-position="left"       bottom-left instead of bottom-right
 *   data-button="none"         no floating button (use your own links or data-openbooking)
 *   data-structured-data="off" skip the schema.org block (e.g. your site already has one)
 *   data-agents="off"          skip WebMCP
 */
import { scriptJson } from './render';

export interface EmbedConfig {
  name: string;
  /** The booking page, opened in the popup. */
  page_url: string;
  /** Absolute base of the booking page JSON API, e.g. https://app.openbooking.sh/b/x/book/api. */
  api_url: string;
  /** schema.org JSON-LD for the business. */
  json_ld: Record<string, unknown>;
}

export function embedScript(cfg: EmbedConfig): string {
  return EMBED_SCRIPT.replace('__OPENBOOKING_CONFIG__', scriptJson(cfg));
}

// Plain ES5 so it runs on any site; no template literals so it can live in String.raw.
const EMBED_SCRIPT = String.raw`/* OpenBooking embed: https://openbooking.sh */
(function () {
  var C = __OPENBOOKING_CONFIG__;
  var key = '__openbooking_' + C.page_url;
  if (window[key]) return;
  window[key] = true;
  var me = document.currentScript || {};
  function opt(name, def) { var v = me.getAttribute && me.getAttribute('data-' + name); return v == null || v === '' ? def : v; }
  var label = opt('label', 'Book now');
  var color = opt('color', '#2747e8');
  var left = opt('position', 'right') === 'left';

  // ---------------------------------------------------------------- popup
  var overlay, frame, closeBtn, lastFocus;
  function open(url) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Book with ' + C.name);
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(11,16,32,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
      var box = document.createElement('div');
      box.style.cssText = 'position:relative;width:100%;max-width:560px;height:min(860px,100%);background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.35);';
      var close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      close.innerHTML = '&times;';
      close.style.cssText = 'position:absolute;top:10px;right:10px;z-index:1;width:36px;height:36px;border:0;border-radius:50%;background:rgba(11,16,32,.08);color:#0b1020;font:24px/36px system-ui,sans-serif;cursor:pointer;';
      close.onclick = hide;
      closeBtn = close;
      frame = document.createElement('iframe');
      frame.title = 'Book with ' + C.name;
      frame.style.cssText = 'border:0;width:100%;height:100%;display:block;';
      frame.setAttribute('allow', 'payment');
      box.appendChild(close);
      box.appendChild(frame);
      overlay.appendChild(box);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.style.display !== 'none') hide(); });
      // The page behind is inert while the dialog is open: focus that escapes comes back.
      document.addEventListener('focusin', function (e) {
        if (overlay.style.display !== 'none' && !overlay.contains(e.target)) closeBtn.focus();
      });
      document.body.appendChild(overlay);
      if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
        overlay.style.padding = '0'; box.style.height = '100%'; box.style.borderRadius = '0';
      }
    }
    var target = url || C.page_url;
    if (frame.getAttribute('src') !== target) frame.setAttribute('src', target);
    if (!overlay.contains(document.activeElement)) lastFocus = document.activeElement;
    overlay.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    closeBtn.focus();
  }
  function hide() {
    if (overlay) overlay.style.display = 'none';
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  ready(function () {
    if (opt('button', '') !== 'none') {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'position:fixed;bottom:20px;' + (left ? 'left' : 'right') + ':20px;z-index:2147483645;border:0;border-radius:999px;padding:13px 22px;background:' + color + ';color:#fff;font:600 15px/1 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(11,16,32,.25);cursor:pointer;';
      b.onclick = function () { open(); };
      document.body.appendChild(b);
    }
    // Links to the booking page and [data-openbooking] elements open the popup instead.
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('a[href],[data-openbooking]') : null;
      if (!el || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
      var href = el.getAttribute('href') || '';
      if (el.hasAttribute('data-openbooking') || href.indexOf(C.page_url) === 0) {
        e.preventDefault();
        open(href.indexOf(C.page_url) === 0 ? href : undefined);
      }
    });
  });

  // ---------------------------------------------------------------- schema.org
  if (opt('structured-data', 'on') !== 'off') {
    try {
      var ld = JSON.parse(JSON.stringify(C.json_ld));
      // On the business's own site, that site is the business's URL; the booking page is an extra.
      ld.url = location.origin + '/';
      ld.sameAs = [C.page_url].concat(ld.sameAs || []);
      var s = document.createElement('script');
      s.type = 'application/ld+json';
      s.text = JSON.stringify(ld);
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- WebMCP
  // Draft API (W3C WebML CG); feature-detected and failure-tolerant.
  function call(path, body) {
    var init = body
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-openbooking-agent': 'webmcp' }, body: JSON.stringify(body) }
      : { headers: { 'x-openbooking-agent': 'webmcp' } };
    return fetch(C.api_url + path, init).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) { var err = new Error((j.error && j.error.message) || 'Request failed'); err.payload = j.error; throw err; }
        return j;
      });
    });
  }
  // WebMCP: current drafts use document.modelContext, where execute resolves to a value (we send a
  // JSON string) and failures reject. Older builds used navigator.modelContext with MCP-style
  // content arrays; they still get that shape.
  var mc = document.modelContext || navigator.modelContext;
  var legacy = !document.modelContext;
  function result(p) {
    return p.then(function (r) {
      return legacy ? { content: [{ type: 'text', text: JSON.stringify(r) }] } : JSON.stringify(r);
    }, function (e) {
      var text = 'Error: ' + e.message + (e.payload ? ' ' + JSON.stringify(e.payload) : '');
      if (legacy) return { isError: true, content: [{ type: 'text', text: text }] };
      throw new Error(text);
    });
  }
  function uuid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  if (mc && opt('agents', 'on') !== 'off') {
    var tools = [
      { name: 'list_services', description: 'List the services of ' + C.name + ' that can be booked, with duration, price and staff.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        execute: function () { return result(call('/info')); } },
      { name: 'search_availability', description: 'Find free times at ' + C.name + ' on a date (YYYY-MM-DD, local time). Returns slot_ids. Nothing is reserved.',
        inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, service_id: { type: 'string' }, staff_id: { type: 'string' }, party_size: { type: 'integer', minimum: 1 } }, required: ['date'] },
        annotations: { readOnlyHint: true },
        execute: function (a) {
          a = a || {};
          var q = '?date=' + encodeURIComponent(a.date || '') + (a.service_id ? '&service=' + encodeURIComponent(a.service_id) : '') +
            (a.staff_id ? '&staff=' + encodeURIComponent(a.staff_id) : '') + (a.party_size ? '&party=' + a.party_size : '');
          return result(call('/availability' + q));
        } },
      { name: 'hold_slot', description: 'Reserve a slot at ' + C.name + ' for a few minutes (until expires_at). Does NOT confirm. Show the user the price, deposit and cancellation policy from the result.',
        inputSchema: { type: 'object', properties: { slot_id: { type: 'string' } }, required: ['slot_id'] },
        execute: function (a) { return result(call('/hold', { slot_id: (a || {}).slot_id, idempotency_key: uuid() })); } },
      { name: 'confirm_booking', description: 'Confirm a held booking at ' + C.name + '. Only set user_confirmed=true after the user has explicitly approved this exact booking (time, service, price, cancellation policy). Needs first and last name plus email or phone.',
        inputSchema: { type: 'object', properties: { booking_id: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' }, user_confirmed: { type: 'boolean' } }, required: ['booking_id', 'first_name', 'last_name', 'user_confirmed'] },
        annotations: { consequentialHint: true },
        execute: function (a) {
          a = a || {};
          var c = { first_name: a.first_name, last_name: a.last_name };
          if (a.email) c.email = a.email;
          if (a.phone) c.phone_number = a.phone;
          var body = { booking_id: a.booking_id, idempotency_key: 'webmcp-confirm-' + a.booking_id, customer: c, user_confirmed: a.user_confirmed === true };
          if (a.notes) body.notes = a.notes;
          return result(call('/confirm', body));
        } }
    ];
    try {
      if (typeof mc.registerTool === 'function') tools.forEach(function (t) { try { Promise.resolve(mc.registerTool(t)).catch(function () {}); } catch (e) {} });
      else if (typeof mc.provideContext === 'function') mc.provideContext({ tools: tools });
    } catch (e) {}
  }

  window.OpenBooking = window.OpenBooking || {};
  window.OpenBooking.open = open;
  window.OpenBooking.close = hide;
})();
`;
