/**
 * Self-serve setup, shown right after sign-up: import from the owner's website, then contact
 * details, services, opening hours and team, one short screen each, and finally "you're live"
 * with the links to share. Every step saves through the Studio settings API, so leaving halfway
 * keeps what was done; everything stays editable in Studio Settings.
 *
 * Plain HTML, no build step. The script avoids backticks and dollar-brace so it can live in this
 * template literal.
 */
export function setupHtml(opts: { studioPath: string; api: string }): string {
  const cfg = JSON.stringify(opts).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Set up your booking · OpenBooking</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='%232747e8'/><path d='M10 16.5l4 4 8-9' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap" rel="stylesheet" />
<style>
  :root { --bg: #f8f8f5; --bg-2: #f1f1ec; --card: #fff; --ink: #0b1020; --ink-2: #4a5068; --ink-3: #8a90a3; --line: rgba(11,16,32,.08); --line-2: rgba(11,16,32,.14); --royal: #2747e8; --royal-2: #1b34c4; --sky: #eaf3ff; --green: #16a34a; --red: #dc2626; --grad: linear-gradient(135deg, #2747e8, #6fb6ff); }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0d14; --bg-2: #11141e; --card: #141826; --ink: #eef0f6; --ink-2: #b4b9cc; --ink-3: #7d8399; --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.16); --royal: #5b75ff; --royal-2: #4561f5; --sky: #18213d; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.5 Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 600px; margin: 0 auto; padding: 32px 16px 64px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -.02em; margin-bottom: 22px; }
  .brand i { width: 26px; height: 26px; border-radius: 8px; background: var(--grad); display: grid; place-items: center; }
  .bar { display: flex; gap: 6px; margin-bottom: 22px; }
  .bar span { flex: 1; height: 4px; border-radius: 4px; background: var(--line-2); }
  .bar span.on { background: var(--royal); }
  h1 { font-size: 26px; line-height: 1.2; letter-spacing: -.03em; font-weight: 500; margin: 0 0 8px; }
  p.lead { color: var(--ink-2); margin: 0 0 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 20px; margin-bottom: 14px; }
  label { font-size: 13px; color: var(--ink-3); display: block; margin-bottom: 4px; }
  input, select { font: inherit; color: inherit; height: 42px; border: 1px solid var(--line-2); border-radius: 11px; padding: 0 12px; background: var(--card); width: 100%; }
  .field { margin-bottom: 12px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .row { display: grid; grid-template-columns: 1fr 90px 110px 36px; gap: 8px; align-items: end; margin-bottom: 8px; }
  .row.head { font-size: 12px; color: var(--ink-3); margin-bottom: 4px; }
  .x { height: 42px; border: 1px solid var(--line-2); border-radius: 11px; background: transparent; color: var(--ink-3); cursor: pointer; font-size: 18px; }
  a.btn { display: inline-flex; align-items: center; text-decoration: none; }
  .btn { font: inherit; height: 44px; border: 0; border-radius: 11px; padding: 0 18px; background: var(--royal); color: #fff; font-weight: 500; cursor: pointer; }
  .btn:hover { background: var(--royal-2); } .btn[disabled] { opacity: .6; cursor: default; }
  .btn.ghost { background: transparent; color: var(--ink-2); border: 1px solid var(--line-2); }
  .btn.small { height: 34px; padding: 0 12px; font-size: 13.5px; }
  .nav { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 18px; }
  .link { background: none; border: 0; color: var(--royal); font: inherit; cursor: pointer; padding: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .chip { font: inherit; font-size: 13.5px; border: 1px solid var(--line-2); background: var(--card); color: var(--ink); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
  .chip:hover { border-color: var(--royal); }
  .hrs { display: grid; grid-template-columns: 70px 1fr; gap: 8px 10px; align-items: center; }
  .found { background: var(--sky); border-radius: 12px; padding: 12px 14px; font-size: 14px; color: var(--ink-2); margin-top: 12px; }
  .err { color: var(--red); font-size: 13.5px; min-height: 20px; margin-top: 8px; }
  .hint { color: var(--ink-3); font-size: 13px; }
  .share { display: grid; gap: 10px; }
  .share .item { display: flex; gap: 10px; align-items: center; justify-content: space-between; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .share b { display: block; font-weight: 500; }
  .snip { font: 12.5px/1.5 'Geist Mono', ui-monospace, monospace; background: var(--bg-2); border-radius: 10px; padding: 10px 12px; word-break: break-all; margin: 8px 0; }
  .done { font-size: 40px; }
  @media (max-width: 520px) { .row { grid-template-columns: 1fr 70px 90px 36px; } .two { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <div class="brand"><i><svg width="13" height="13" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></i>OpenBooking</div>
  <div class="bar" id="bar"></div>
  <div id="step"></div>
  <div class="err" id="err"></div>
</main>
<script id="cfg" type="application/json">${cfg}</script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var token = '';
  try { token = sessionStorage.getItem('ob-studio-token') || ''; } catch (e) {}
  if (!token) { location.href = cfg.studioPath; return; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token };
    return fetch(cfg.api + path, opts).then(function (r) {
      if (r.status === 401) { location.href = cfg.studioPath; throw new Error('Log in again'); }
      return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || 'Something went wrong'); return j; });
    });
  }
  function slug(s) { return String(s).toLowerCase().normalize('NFKD').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'; }
  function uniq(name, taken) { var b = slug(name), id = b, n = 2; while (taken.indexOf(id) >= 0) id = b.slice(0, 36) + '-' + n++; taken.push(id); return id; }
  function copy(text, btn) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500); }, function () { prompt('Copy this', text); });
  }

  var SV = null, S = null, step = 0, imported = null;
  var STEPS = ['import', 'contact', 'services', 'hours', 'team', 'live'];
  var DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

  function save() {
    $('err').textContent = '';
    return api('/settings', { method: 'PUT', body: JSON.stringify(S) }).then(function (v) { SV = v; S = JSON.parse(JSON.stringify(v.settings)); });
  }
  function next() {
    var collect = COLLECT[STEPS[step]];
    var problem = collect ? collect() : '';
    if (problem) { $('err').textContent = problem; return; }
    var b = document.querySelector('[data-next]'); if (b) b.disabled = true;
    save().then(function () { step++; render(); }).catch(function (e) { $('err').textContent = e.message; if (b) b.disabled = false; });
  }
  function back() { $('err').textContent = ''; step--; render(); }
  function nav(nextLabel, skip) {
    return '<div class="nav">' + (step > 0 ? '<button class="link" data-back>Back</button>' : '<span></span>') +
      '<span>' + (skip ? '<button class="link" data-skip style="margin-right:16px">' + esc(skip) + '</button>' : '') +
      '<button class="btn" data-next>' + esc(nextLabel || 'Continue') + '</button></span></div>';
  }
  function money(minor) { return minor == null ? '' : String(minor / 100); }
  function hoursText(list) { return (list || []).map(function (p) { return p.open + '-' + p.close; }).join(', '); }
  function parseHours(text) {
    var t = text.trim(); if (!t) return [];
    return t.split(',').map(function (part) {
      var m = /^\\s*(\\d{1,2})[:.](\\d{2})\\s*-\\s*(\\d{1,2})[:.](\\d{2})\\s*$/.exec(part);
      if (!m) throw new Error('Write hours like 09:00-17:00');
      var o = ('0' + m[1]).slice(-2) + ':' + m[2], c = ('0' + m[3]).slice(-2) + ':' + m[4];
      if (o >= c) throw new Error('Opening time must be before closing time (' + part.trim() + ')');
      return { open: o, close: c };
    });
  }

  var RENDER = {
    'import': function () {
      return '<h1>Let&#39;s get ' + esc(S.profile.name) + ' bookable</h1><p class="lead">Have a website or an existing booking page? We&#39;ll read your address, opening hours and services from it, so there&#39;s less to type.</p>' +
        '<div class="card"><label for="url">Your website</label><div style="display:flex;gap:8px"><input id="url" placeholder="studionord.no" value="' + esc(S.profile.website || '') + '" /><button class="btn" id="imp">Import</button></div>' +
        (imported ? '<div class="found">' + found(imported) + '</div>' : '') + '</div>' +
        nav('Continue', imported ? '' : "I don't have a website");
    },
    contact: function () {
      var p = S.profile, a = p.address || {};
      return '<h1>Where can customers find you?</h1><p class="lead">AI assistants and Google show this, and customers trust bookings more with a real address and phone number.</p><div class="card">' +
        '<div class="field"><label for="street">Street address</label><input id="street" value="' + esc(a.street_address) + '" autocomplete="street-address" /></div>' +
        '<div class="two"><div class="field"><label for="zip">Postal code</label><input id="zip" value="' + esc(a.postal_code) + '" autocomplete="postal-code" /></div>' +
        '<div class="field"><label for="city">City</label><input id="city" value="' + esc(a.address_locality) + '" autocomplete="address-level2" /></div></div>' +
        '<div class="field"><label for="phone">Phone</label><input id="phone" value="' + esc(p.phone_number) + '" placeholder="+47 ..." autocomplete="tel" /></div>' +
        '<div class="field" style="margin:0"><label for="desc">One line about you (optional)</label><input id="desc" maxlength="300" value="' + esc(p.description) + '" placeholder="e.g. Friendly neighbourhood salon since 2012" /></div></div>' + nav();
    },
    services: function () {
      var cur = S.profile.currency;
      return '<h1>What can customers book?</h1><p class="lead">' + (imported && imported.services.length ? 'These come from your website. ' : 'We started you with typical services. ') + 'Change names, minutes and prices to match yours.</p><div class="card">' +
        '<div class="row head"><span>Service</span><span>Minutes</span><span>Price (' + esc(cur) + ')</span><span></span></div>' +
        S.services.map(function (s, i) {
          return '<div class="row" data-i="' + i + '"><input class="sv-name" value="' + esc(s.name) + '" /><input class="sv-min" type="number" min="5" step="5" value="' + esc(s.duration_minutes) + '" /><input class="sv-price" type="number" min="0" step="1" value="' + esc(money(s.price)) + '" placeholder="on request" /><button class="x" data-rm="' + i + '" aria-label="Remove">&times;</button></div>';
        }).join('') +
        '<button class="btn ghost small" id="add-svc" style="margin-top:6px">+ Add a service</button></div>' + nav();
    },
    hours: function () {
      return '<h1>When are you open?</h1><p class="lead">Pick a common pattern, then adjust any day. Leave a day empty when you&#39;re closed.</p>' +
        '<div class="chips"><button class="chip" data-preset="mon-fri">Mon-Fri 9-17</button><button class="chip" data-preset="tue-sat">Tue-Sat 10-18</button><button class="chip" data-preset="mon-sat">Mon-Sat 9-18</button><button class="chip" data-preset="late">Mon-Fri 10-20, Sat 10-16</button></div>' +
        '<div class="card"><div class="hrs">' + DAYS.map(function (d) { return '<label for="h-' + d[0] + '" style="margin:0">' + d[1] + '</label><input id="h-' + d[0] + '" value="' + esc(hoursText(S.opening_hours[d[0]])) + '" placeholder="Closed" />'; }).join('') + '</div>' +
        '<p class="hint" style="margin:12px 0 0">Lunch break? Write 09:00-12:00, 13:00-17:00.</p></div>' + nav();
    },
    team: function () {
      return '<h1>Who takes appointments?</h1><p class="lead">Customers can pick a person or take the first free time. Just you is fine.</p><div class="card">' +
        S.staff.map(function (m, i) {
          return '<div class="row" style="grid-template-columns:1fr 36px" data-i="' + i + '"><input class="st-name" value="' + esc(m.name) + '" />' + (S.staff.length > 1 ? '<button class="x" data-rm-staff="' + i + '" aria-label="Remove">&times;</button>' : '<span></span>') + '</div>';
        }).join('') + '<button class="btn ghost small" id="add-staff" style="margin-top:6px">+ Add someone</button></div>' + nav('Finish setup');
    },
    live: function () {
      var links = {}; (SV.links || []).forEach(function (l) { links[l.label] = l.url; });
      var I = SV.install || {};
      var verify = SV.account && SV.account.email_verified === false;
      return '<div class="done">&#127881;</div><h1>' + esc(S.profile.name) + ' is bookable</h1><p class="lead">Customers can book you now on your booking page and by asking ChatGPT, Claude or Gemini.' + (verify ? ' <b>One last thing:</b> click the link we emailed to ' + esc(SV.account.email) + ' so AI assistants can find you.' : '') + '</p>' +
        '<div class="card share">' +
        '<div class="item"><span><b>Try it yourself</b><span class="hint">Ask an assistant to book you, like a customer would.</span></span><span style="display:flex;gap:6px">' + (links['Book me through ChatGPT'] ? '<a class="btn small" target="_blank" rel="noopener" href="' + esc(links['Book me through ChatGPT']) + '">ChatGPT</a>' : '') + (links['Book me through Claude'] ? '<a class="btn small ghost" target="_blank" rel="noopener" href="' + esc(links['Book me through Claude']) + '">Claude</a>' : '') + '</span></div>' +
        '<div class="item"><span><b>Your booking page</b><span class="hint">' + esc(I.booking_page) + '</span></span><span style="display:flex;gap:6px"><button class="btn small ghost" data-copy="' + esc(I.booking_page) + '">Copy</button><a class="btn small ghost" target="_blank" rel="noopener" href="' + esc(I.booking_page) + '">Open</a></span></div>' +
        '<div class="item"><span><b>Add it to Google</b><span class="hint">In <a href="https://business.google.com/" target="_blank" rel="noopener">Google Business Profile</a>, open Bookings and paste your booking page link. A Book button appears in Search and Maps.</span></span></div>' +
        '<div class="item" style="display:block"><b>Add it to your website</b><span class="hint">Paste this line into your site (Wix: Custom code. Squarespace: Code injection. WordPress: WPCode).</span><div class="snip">' + esc(I.snippet) + '</div><button class="btn small ghost" data-copy="' + esc(I.snippet) + '">Copy code</button></div>' +
        '</div><div class="nav"><span></span><a class="btn" href="' + esc(cfg.studioPath) + '">Open my Studio</a></div>';
    }
  };

  var COLLECT = {
    contact: function () {
      var p = S.profile; p.address = p.address || {};
      p.address.street_address = $('street').value.trim() || undefined;
      p.address.postal_code = $('zip').value.trim() || undefined;
      p.address.address_locality = $('city').value.trim() || undefined;
      p.phone_number = $('phone').value.trim() || undefined;
      p.description = $('desc').value.trim() || undefined;
      return '';
    },
    services: function () {
      var problem = '';
      document.querySelectorAll('.row[data-i]').forEach(function (row) {
        var s = S.services[Number(row.getAttribute('data-i'))];
        s.name = row.querySelector('.sv-name').value.trim();
        s.duration_minutes = Math.round(Number(row.querySelector('.sv-min').value));
        var price = row.querySelector('.sv-price').value.trim();
        s.price = price === '' ? null : Math.round(Number(price.replace(',', '.')) * 100);
        if (!s.name) problem = 'Give every service a name, or remove it.';
        else if (!(s.duration_minutes >= 5)) problem = 'How many minutes does ' + s.name + ' take?';
        else if (s.price !== null && !(s.price >= 0)) problem = 'Check the price of ' + s.name + '.';
      });
      if (!S.services.length) problem = 'Add at least one service.';
      // New rows get an id from their name.
      var taken = S.services.map(function (s) { return s.id; }).filter(Boolean);
      S.services.forEach(function (s) { if (!s.id) s.id = uniq(s.name || 'service', taken); });
      return problem;
    },
    hours: function () {
      try {
        DAYS.forEach(function (d) { S.opening_hours[d[0]] = parseHours($('h-' + d[0]).value); });
      } catch (e) { return e.message; }
      return DAYS.some(function (d) { return S.opening_hours[d[0]].length; }) ? '' : 'Add opening hours for at least one day.';
    },
    team: function () {
      var problem = '';
      var taken = [];
      document.querySelectorAll('.row[data-i]').forEach(function (row) {
        var m = S.staff[Number(row.getAttribute('data-i'))];
        m.name = row.querySelector('.st-name').value.trim();
        if (!m.name) problem = 'Add a name for everyone, or remove the empty row.';
        if (!m.id) m.id = uniq(m.name || 'staff', taken.concat(S.staff.map(function (x) { return x.id; }).filter(Boolean)));
        taken.push(m.id);
      });
      var ids = S.staff.map(function (m) { return m.id; });
      S.services.forEach(function (s) { s.staff_ids = (s.staff_ids || []).filter(function (x) { return ids.indexOf(x) >= 0; }); });
      return problem;
    }
  };

  function found(p) {
    var bits = [];
    if (p.profile.address && (p.profile.address.street_address || p.profile.address.address_locality)) bits.push('address');
    if (p.profile.phone_number) bits.push('phone number');
    if (p.opening_hours) bits.push('opening hours');
    if (p.services.length) bits.push(p.services.length + ' services');
    return bits.length ? 'Found your ' + bits.join(', ').replace(/, ([^,]*)$/, ' and $1') + '. Check them on the next screens.' : 'We couldn&#39;t find details on that page. No problem: fill them in on the next screens.';
  }

  /** Merge an import into the settings draft: imported details win where they exist. */
  function applyImport(p) {
    var prof = S.profile, a = p.profile.address || {};
    prof.address = prof.address || {};
    ['street_address', 'postal_code', 'address_locality', 'address_country'].forEach(function (k) { if (a[k]) prof.address[k] = a[k]; });
    if (p.profile.phone_number) prof.phone_number = p.profile.phone_number;
    if (p.profile.description && !prof.description) prof.description = p.profile.description.slice(0, 300);
    if (p.profile.email && !prof.email) prof.email = p.profile.email;
    if (p.profile.website) prof.website = p.profile.website;
    if (p.opening_hours) DAYS.forEach(function (d) { S.opening_hours[d[0]] = p.opening_hours[d[0]] || []; });
    if (p.services.length) {
      var taken = [];
      S.services = p.services.map(function (s) {
        return { id: uniq(s.name, taken), name: s.name, duration_minutes: s.duration_minutes || 45, price: s.price == null ? null : s.price, staff_ids: [] };
      });
    }
  }

  function bind() {
    var nb = document.querySelector('[data-next]'); if (nb) nb.onclick = next;
    var bb = document.querySelector('[data-back]'); if (bb) bb.onclick = back;
    var sk = document.querySelector('[data-skip]'); if (sk) sk.onclick = function () { step++; render(); };
    document.querySelectorAll('[data-copy]').forEach(function (b) { b.onclick = function () { copy(b.getAttribute('data-copy'), b); }; });
    if ($('imp')) {
      var run = function () {
        var url = $('url').value.trim(); if (!url) { $('err').textContent = 'Enter your website address, or skip this step.'; return; }
        $('imp').disabled = true; $('imp').textContent = 'Reading...'; $('err').textContent = '';
        api('/import', { method: 'POST', body: JSON.stringify({ url: url }) })
          .then(function (p) { imported = p; applyImport(p); render(); })
          .catch(function (e) { $('err').textContent = e.message; $('imp').disabled = false; $('imp').textContent = 'Import'; });
      };
      $('imp').onclick = run;
      $('url').onkeydown = function (e) { if (e.key === 'Enter') run(); };
    }
    if ($('add-svc')) $('add-svc').onclick = function () { COLLECT.services(); $('err').textContent = ''; S.services.push({ id: '', name: '', duration_minutes: 30, price: null, staff_ids: [] }); render(); };
    document.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { COLLECT.services(); $('err').textContent = ''; S.services.splice(Number(b.getAttribute('data-rm')), 1); render(); }; });
    document.querySelectorAll('[data-preset]').forEach(function (b) {
      b.onclick = function () {
        var P = { 'mon-fri': [['mon', 'tue', 'wed', 'thu', 'fri'], '09:00', '17:00'], 'tue-sat': [['tue', 'wed', 'thu', 'fri', 'sat'], '10:00', '18:00'], 'mon-sat': [['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], '09:00', '18:00'], 'late': [['mon', 'tue', 'wed', 'thu', 'fri'], '10:00', '20:00'] }[b.getAttribute('data-preset')];
        DAYS.forEach(function (d) { $('h-' + d[0]).value = P[0].indexOf(d[0]) >= 0 ? P[1] + '-' + P[2] : ''; });
        if (b.getAttribute('data-preset') === 'late') $('h-sat').value = '10:00-16:00';
      };
    });
    if ($('add-staff')) $('add-staff').onclick = function () { COLLECT.team(); $('err').textContent = ''; S.staff.push({ id: '', name: '' }); render(); };
    document.querySelectorAll('[data-rm-staff]').forEach(function (b) { b.onclick = function () { COLLECT.team(); $('err').textContent = ''; S.staff.splice(Number(b.getAttribute('data-rm-staff')), 1); render(); }; });
  }

  function render() {
    $('bar').innerHTML = STEPS.map(function (_, i) { return '<span class="' + (i <= step ? 'on' : '') + '"></span>'; }).join('');
    $('step').innerHTML = RENDER[STEPS[step]]();
    bind();
    window.scrollTo(0, 0);
    var first = document.querySelector('#step input'); if (first && step > 0) first.focus();
  }

  api('/settings').then(function (v) { SV = v; S = JSON.parse(JSON.stringify(v.settings)); render(); })
    .catch(function (e) { $('err').textContent = e.message; });
})();
</script>
</body>
</html>`;
}
