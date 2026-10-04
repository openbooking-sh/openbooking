/**
 * Browser scripts for the booking page and the manage page. Plain ES5-ish JS, no build step.
 * They live in String.raw template literals, so they must not contain backticks or the
 * dollar-brace sequence. Server data arrives via the JSON in #ob-data and is HTML-escaped before
 * it is rendered.
 */

export const PAGE_SCRIPT = String.raw`
(function () {
  var D = JSON.parse(document.getElementById('ob-data').textContent);
  var API = D.api_path;
  var TZ = D.venue.timezone;
  var P = D.prefill || {};
  var state = { service: null, staff: P.staff || '', date: null, party: P.party || 1, hold: null, confirmKey: null, timer: null, slots: [] };

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
  }
  function api(path, body, agent) {
    var opts = { headers: { 'content-type': 'application/json' } };
    if (agent) opts.headers['x-openbooking-agent'] = agent;
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
    return fetch(API + '/api' + path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) {
          var e = new Error((j.error && j.error.message) || 'Something went wrong. Please try again.');
          e.payload = j.error; throw e;
        }
        return j;
      });
    });
  }
  function money(m) {
    if (!m) return '';
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: m.currency, maximumFractionDigits: m.amount % 100 ? 2 : 0 }).format(m.amount / 100);
    } catch (e) { return (m.amount / 100) + ' ' + m.currency; }
  }
  function parts(d) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function today() { var p = parts(new Date()); return p.year + '-' + p.month + '-' + p.day; }
  function addDays(d, n) { var t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function fmtTime(iso) { var p = parts(new Date(iso)); return p.hour + ':' + p.minute; }
  function fmtDay(d, opts) { return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'UTC' }, opts)).format(new Date(d + 'T12:00:00Z')); }
  function fmtWhen(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)) + ' at ' + fmtTime(iso);
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  // ------------------------------------------------------------------ services
  function renderServices() {
    if (!D.offerings.length) { $('services').innerHTML = '<div class="muted">No services can be booked online yet.</div>'; return; }
    $('services').innerHTML = D.offerings.map(function (o) {
      return '<button class="opt' + (state.service && state.service.id === o.id ? ' on' : '') + '" data-id="' + esc(o.id) + '"><span><b>' + esc(o.name) + '</b><small>' +
        o.duration_minutes + ' min' + (o.description ? ' · ' + esc(o.description) : '') + '</small></span><span class="p">' + (o.price ? money(o.price) : '') + '</span></button>';
    }).join('');
    $('services').querySelectorAll('.opt').forEach(function (b) {
      b.onclick = function () { pickService(b.getAttribute('data-id')); };
    });
  }
  function pickService(id) {
    state.service = D.offerings.filter(function (o) { return o.id === id; })[0] || null;
    renderServices();
    if (!state.service) return;
    show('s-when', true);
    renderStaff();
    if (!state.date) state.date = P.date && P.date >= today() ? P.date : today();
    renderDates();
    loadTimes();
  }

  // ------------------------------------------------------------------ staff, party, date
  function renderStaff() {
    show('staff-wrap', D.staff.length > 1);
    var opts = [{ id: '', name: 'Anyone' }].concat(D.staff);
    $('staff').innerHTML = opts.map(function (s) {
      return '<button class="chip' + (state.staff === s.id ? ' on' : '') + '" data-id="' + esc(s.id) + '">' + esc(s.name) + '</button>';
    }).join('');
    $('staff').querySelectorAll('.chip').forEach(function (b) {
      b.onclick = function () { state.staff = b.getAttribute('data-id'); renderStaff(); loadTimes(); };
    });
  }
  function renderDates() {
    var t = today(), h = '';
    for (var i = 0; i < 14; i++) {
      var d = addDays(t, i);
      var label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' });
      h += '<button class="chip' + (d === state.date ? ' on' : '') + '" data-d="' + d + '">' + esc(label) + '</button>';
    }
    $('dates').innerHTML = h;
    $('dates').querySelectorAll('.chip').forEach(function (b) {
      b.onclick = function () { setDate(b.getAttribute('data-d')); };
    });
    $('date').min = t;
    $('date').value = state.date || '';
  }
  function setDate(d) { if (!d) return; state.date = d; renderDates(); loadTimes(); }
  $('date').onchange = function () { setDate($('date').value); };
  show('party-wrap', D.show_party);
  $('party').value = state.party;
  $('party').onchange = function () {
    var n = Number($('party').value);
    if (n >= 1 && n <= 50) { state.party = Math.floor(n); loadTimes(); }
  };

  // ------------------------------------------------------------------ times
  var seq = 0;
  function loadTimes() {
    if (!state.service || !state.date) return;
    var my = ++seq;
    $('times').innerHTML = '';
    $('times-msg').textContent = 'Checking free times…';
    var q = '?date=' + encodeURIComponent(state.date) + '&service=' + encodeURIComponent(state.service.id) +
      '&party=' + state.party + (state.staff ? '&staff=' + encodeURIComponent(state.staff) : '');
    api('/availability' + q).then(function (r) {
      if (my !== seq) return;
      state.slots = r.slots;
      if (!r.slots.length) {
        $('times-msg').textContent = 'No free times on ' + fmtDay(state.date, { weekday: 'long', day: 'numeric', month: 'long' }) + '. Try another day.';
        return;
      }
      var hinted = P.time && state.date === P.date;
      var hit = false;
      $('times').innerHTML = r.slots.map(function (s, i) {
        var hint = hinted && fmtTime(s.start) === P.time;
        if (hint) hit = true;
        return '<button class="chip' + (hint ? ' hint' : '') + '" data-i="' + i + '" title="' + esc(s.resource ? s.resource.label : '') + '">' + fmtTime(s.start) + '</button>';
      }).join('');
      $('times-msg').textContent = hinted ? (hit ? 'Your requested time ' + P.time + ' is free. Tap it to continue.' : P.time + ' is no longer free. Pick another time.') : '';
      $('times').querySelectorAll('.chip').forEach(function (b) {
        b.onclick = function () { pickSlot(state.slots[Number(b.getAttribute('data-i'))], b); };
      });
    }).catch(function (e) { if (my === seq) $('times-msg').textContent = e.message; });
  }

  function release() {
    if (state.hold && state.hold.status === 'held') {
      api('/holds/' + encodeURIComponent(state.hold.booking_id) + '/release', {}).catch(function () {});
    }
    state.hold = null;
    if (state.timer) clearInterval(state.timer);
  }

  function pickSlot(slot, btn) {
    if (!slot) return;
    if (slot.deposit && slot.deposit.due === 'at_confirmation') {
      $('times-msg').innerHTML = '<div class="warn">This service needs a deposit of ' + money(slot.deposit.amount) +
        ', which can\'t be paid online yet. Please contact ' + esc(D.venue.name) + (D.venue.phone_number ? ' on ' + esc(D.venue.phone_number) : '') + ' to book.</div>';
      return;
    }
    release();
    $('times').querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('on', x === btn); x.disabled = true; });
    $('times-msg').textContent = 'Holding ' + fmtTime(slot.start) + ' for you…';
    api('/hold', { slot_id: slot.slot_id, idempotency_key: uuid() }).then(function (h) {
      state.hold = h.booking;
      state.confirmKey = uuid();
      $('times-msg').textContent = '';
      renderReview($('review'), h.booking);
      show('s-details', true);
      startCountdown();
      $('s-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      $('times-msg').textContent = e.message;
      loadTimes();
    }).then(function () {
      $('times').querySelectorAll('.chip').forEach(function (x) { x.disabled = false; });
    });
  }

  function renderReview(el, b) {
    var p = b.cancellation_policy;
    var rows = [
      ['When', esc(fmtWhen(b.start))],
      ['Service', esc(b.offering.name) + (b.party_size > 1 ? ' · ' + b.party_size + ' guests' : '')],
      b.resource ? ['With', esc(b.resource)] : null,
      ['Price', b.price ? money(b.price) : 'Paid at ' + esc(D.venue.name)],
      b.deposit ? ['Deposit', money(b.deposit.amount) + ' · ' + esc(b.deposit.description)] : null,
      ['Cancellation', esc(p.description)]
    ].filter(Boolean);
    el.innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('');
  }

  function startCountdown() {
    if (state.timer) clearInterval(state.timer);
    var tick = function () {
      if (!state.hold) return;
      var left = Math.floor((new Date(state.hold.expires_at).getTime() - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(state.timer);
        state.hold = null;
        show('s-details', false);
        $('times-msg').textContent = 'Your hold expired and the time was released. Please pick a time again.';
        loadTimes();
        return;
      }
      $('hold-note').textContent = 'We\'re holding this time for you for ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '. It isn\'t booked until you confirm.';
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------ confirm
  $('confirm').onclick = function () {
    if (!state.hold) return;
    var customer = { first_name: $('first').value.trim(), last_name: $('last').value.trim() };
    if ($('email').value.trim()) customer.email = $('email').value.trim();
    if ($('phone').value.trim()) customer.phone_number = $('phone').value.trim();
    if (!customer.first_name || !customer.last_name) { $('err').textContent = 'Please enter your first and last name.'; return; }
    if (!customer.email && !customer.phone_number) { $('err').textContent = 'Please enter an email or a phone number.'; return; }
    $('err').textContent = '';
    $('confirm').disabled = true;
    var body = { booking_id: state.hold.booking_id, idempotency_key: state.confirmKey, customer: customer, user_confirmed: true };
    if ($('notes').value.trim()) body.notes = $('notes').value.trim();
    api('/confirm', body).then(function (r) {
      if (state.timer) clearInterval(state.timer);
      state.hold = null;
      done(r.booking);
    }).catch(function (e) {
      $('err').textContent = e.message;
      if (e.payload && (e.payload.code === 'hold_expired' || e.payload.code === 'invalid_state')) {
        state.hold = null; show('s-details', false); loadTimes();
      }
    }).then(function () { $('confirm').disabled = false; });
  };

  function icsDate(iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); }
  function icsText(s) { return String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'); }
  function done(b) {
    ['s-service', 's-when', 's-details'].forEach(function (id) { show(id, false); });
    show('s-done', true);
    $('done-code').textContent = b.confirmation_code || '';
    renderReview($('done-review'), b);
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenBooking//Booking page//EN', 'BEGIN:VEVENT',
      'UID:' + b.booking_id + '@openbooking', 'DTSTAMP:' + icsDate(new Date().toISOString()),
      'DTSTART:' + icsDate(b.start), 'DTEND:' + icsDate(b.end),
      'SUMMARY:' + icsText(b.offering.name + ' at ' + D.venue.name),
      'DESCRIPTION:' + icsText('Confirmation code ' + (b.confirmation_code || '') + (b.manage_url ? '. Manage: ' + b.manage_url : '')),
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    $('ics').href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
    if (b.manage_url) $('manage').href = b.manage_url; else $('manage').parentNode.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ pre-fill
  if (P.first_name) $('first').value = P.first_name;
  if (P.last_name) $('last').value = P.last_name;
  if (P.email) $('email').value = P.email;
  if (P.phone) $('phone').value = P.phone;
  renderServices();
  if (P.service) pickService(P.service);
  else if (D.offerings.length === 1) pickService(D.offerings[0].id);
  window.addEventListener('pagehide', function () { /* holds lapse on their own; nothing to do */ });

  // ------------------------------------------------------------------ WebMCP
  // WebMCP (navigator.modelContext) is a draft from the W3C Web Machine Learning Community Group;
  // the API shape may still change, so everything here is feature-detected and failure-tolerant.
  function registerWebMcp() {
    var mc = navigator.modelContext;
    if (!mc) return;
    function result(p) {
      return p.then(function (r) { return { content: [{ type: 'text', text: JSON.stringify(r) }] }; })
        .catch(function (e) { return { isError: true, content: [{ type: 'text', text: 'Error: ' + e.message + (e.payload ? ' ' + JSON.stringify(e.payload) : '') }] }; });
    }
    var tools = [
      {
        name: 'list_services',
        description: 'List the services of ' + D.venue.name + ' that can be booked, with duration, price and staff.',
        inputSchema: { type: 'object', properties: {} },
        execute: function () { return result(api('/info', null, 'webmcp')); }
      },
      {
        name: 'search_availability',
        description: 'Find free times at ' + D.venue.name + ' on a date (YYYY-MM-DD, venue local time). Returns slot_ids. Nothing is reserved.',
        inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, service_id: { type: 'string' }, staff_id: { type: 'string' }, party_size: { type: 'integer', minimum: 1 } }, required: ['date'] },
        execute: function (a) {
          a = a || {};
          var q = '?date=' + encodeURIComponent(a.date || '') + (a.service_id ? '&service=' + encodeURIComponent(a.service_id) : '') +
            (a.staff_id ? '&staff=' + encodeURIComponent(a.staff_id) : '') + (a.party_size ? '&party=' + a.party_size : '');
          return result(api('/availability' + q, null, 'webmcp'));
        }
      },
      {
        name: 'hold_slot',
        description: 'Reserve a slot for a few minutes (until expires_at). Does NOT confirm. Show the user the price, deposit and cancellation policy from the result.',
        inputSchema: { type: 'object', properties: { slot_id: { type: 'string' } }, required: ['slot_id'] },
        execute: function (a) { return result(api('/hold', { slot_id: (a || {}).slot_id, idempotency_key: uuid() }, 'webmcp')); }
      },
      {
        name: 'confirm_booking',
        description: 'Confirm a held booking. Only set user_confirmed=true after the user has explicitly approved this exact booking (time, service, price, cancellation policy) in this conversation. Needs first and last name plus email or phone.',
        inputSchema: { type: 'object', properties: { booking_id: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' }, user_confirmed: { type: 'boolean' } }, required: ['booking_id', 'first_name', 'last_name', 'user_confirmed'] },
        execute: function (a) {
          a = a || {};
          var c = { first_name: a.first_name, last_name: a.last_name };
          if (a.email) c.email = a.email;
          if (a.phone) c.phone_number = a.phone;
          var body = { booking_id: a.booking_id, idempotency_key: 'webmcp-confirm-' + a.booking_id, customer: c, user_confirmed: a.user_confirmed === true };
          if (a.notes) body.notes = a.notes;
          return result(api('/confirm', body, 'webmcp'));
        }
      }
    ];
    if (typeof mc.registerTool === 'function') {
      tools.forEach(function (t) { try { mc.registerTool(t); } catch (e) {} });
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: tools });
    }
  }
  try { registerWebMcp(); } catch (e) {}
})();
`;

export const MANAGE_SCRIPT = String.raw`
(function () {
  var D = JSON.parse(document.getElementById('ob-data').textContent);
  var API = D.api_path;
  var TZ = D.venue.timezone;
  var id = decodeURIComponent(location.pathname.split('/').pop() || '');
  var code = new URLSearchParams(location.search).get('code') || '';
  var key = null;
  function $(x) { return document.getElementById(x); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(m) { return m ? (m.amount / 100).toFixed(m.amount % 100 ? 2 : 0) + ' ' + m.currency : ''; }
  function when(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  }
  function api(path, body) {
    var opts = { headers: { 'content-type': 'application/json' } };
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
    return fetch(API + '/api' + path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) { var e = new Error((j.error && j.error.message) || 'Something went wrong.'); e.payload = j.error; throw e; }
        return j;
      });
    });
  }
  var STATUS = { confirmed: 'Confirmed', cancelled: 'Cancelled', held: 'Not confirmed', expired: 'Expired' };
  function render(b) {
    var rows = [
      ['Status', esc(STATUS[b.status] || b.status)],
      ['When', esc(when(b.start))],
      ['Service', esc(b.offering.name)],
      b.resource ? ['With', esc(b.resource)] : null,
      ['Name', b.customer ? esc(b.customer.first_name + ' ' + b.customer.last_name) : ''],
      ['Code', '<span style="font-family:var(--mono)">' + esc(b.confirmation_code || '') + '</span>'],
      b.price ? ['Price', money(b.price)] : null,
      ['Cancellation', esc(b.cancellation_policy.description)],
      b.cancellation && b.cancellation.fee ? ['Fee charged', money(b.cancellation.fee)] : null
    ].filter(Boolean);
    $('body').classList.remove('muted');
    $('body').innerHTML = '<dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>';
    $('cancel-box').classList.toggle('hidden', b.status !== 'confirmed');
  }
  function load() {
    api('/bookings/' + encodeURIComponent(id) + '?code=' + encodeURIComponent(code))
      .then(function (r) { render(r.booking); })
      .catch(function (e) { $('body').textContent = e.payload && e.payload.code === 'not_found' ? 'We couldn\'t find this booking. Check the link in your confirmation email.' : e.message; });
  }
  var confirming = false;
  $('cancel').onclick = function () {
    $('err').textContent = '';
    $('cancel').disabled = true;
    if (!key) key = 'cancel-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    api('/bookings/' + encodeURIComponent(id) + '/cancel', { code: code, idempotency_key: key + (confirming ? '-yes' : ''), user_confirmed: confirming })
      .then(function (r) { render(r.booking); $('terms').classList.add('hidden'); })
      .catch(function (e) {
        if (e.payload && e.payload.code === 'user_confirmation_required' && !confirming) {
          confirming = true;
          $('terms').classList.remove('hidden');
          $('terms').textContent = e.message + ' Are you sure you want to cancel?';
          $('cancel').textContent = 'Yes, cancel my booking';
        } else { $('err').textContent = e.message; }
      })
      .then(function () { $('cancel').disabled = false; });
  };
  load();
})();
`;
