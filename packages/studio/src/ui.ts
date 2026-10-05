/**
 * OpenBooking Studio single-page UI. Plain HTML/CSS/JS, no build step.
 * NOTE: the client script below deliberately avoids backticks and dollar-brace sequences so it
 * can live inside this template literal unescaped. All server data is HTML-escaped before
 * rendering (customer names and notes come from AI agents and must be treated as untrusted).
 */
export const STUDIO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>OpenBooking Studio</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='%232747e8'/><path d='M10 16.5l4 4 8-9' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #f8f8f5; --bg-2: #f1f1ec; --card: #fff; --ink: #0b1020; --ink-2: #4a5068; --ink-3: #8a90a3;
    --line: rgba(11,16,32,.08); --line-2: rgba(11,16,32,.14); --royal: #2747e8; --royal-2: #1b34c4;
    --sky: #6fb6ff; --sky-bg: #eaf3ff; --green: #16a34a; --green-bg: #e8f7ee; --amber: #b45309;
    --amber-bg: #fdf3e2; --red: #dc2626; --red-bg: #fdecec; --mono: 'Geist Mono', ui-monospace, monospace;
    --grad: linear-gradient(135deg, #2747e8, #6fb6ff);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 400 14.5px/1.5 Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  button, input, select, textarea { font: inherit; color: inherit; }
  .app { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
  aside { border-right: 1px solid var(--line); padding: 18px 12px; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 2px; background: var(--bg); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -.02em; padding: 4px 10px 6px; }
  .brand i { width: 24px; height: 24px; border-radius: 7px; background: var(--grad); display: grid; place-items: center; }
  .venue-name { padding: 0 10px 16px; color: var(--ink-3); font-size: 13px; }
  .nav { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; color: var(--ink-2); cursor: pointer; border: 0; background: none; text-align: left; width: 100%; }
  .nav:hover { background: var(--bg-2); color: var(--ink); }
  .nav.active { background: var(--card); color: var(--ink); box-shadow: 0 1px 2px rgba(11,16,32,.06), inset 0 0 0 1px var(--line); font-weight: 500; }
  .nav svg { width: 17px; height: 17px; flex: none; }
  .nav-sep { height: 1px; background: var(--line); margin: 10px 8px; }
  .aside-foot { margin-top: auto; font-size: 12.5px; color: var(--ink-3); padding: 10px; }
  .aside-foot a { color: var(--royal); text-decoration: none; }
  main { padding: 24px 30px 60px; min-width: 0; }
  header.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 23px; letter-spacing: -.03em; font-weight: 500; }
  .sub { color: var(--ink-3); font-size: 13.5px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px; min-width: 0; }
  .card h2 { margin: 0 0 14px; font-size: 15px; font-weight: 500; display: flex; justify-content: space-between; align-items: center; }
  .card h2 span { font-weight: 400; color: var(--ink-3); font-size: 12.5px; }
  .grid { display: grid; gap: 14px; }
  .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .kpi .v { font-size: 28px; font-weight: 500; letter-spacing: -.04em; margin-top: 4px; }
  .kpi .l { font-size: 12.5px; color: var(--ink-3); }
  .two { grid-template-columns: 1.05fr 1fr; margin-top: 14px; }
  .btn { height: 36px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--card); cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
  a.btn { text-decoration: none; color: inherit; }
  .btn:hover { background: var(--bg-2); }
  .btn-primary { background: var(--royal); border-color: var(--royal); color: #fff; }
  .btn-primary:hover { background: var(--royal-2); }
  .btn-danger { color: var(--red); border-color: rgba(220,38,38,.3); }
  .btn-sm { height: 30px; padding: 0 10px; font-size: 13px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* Calendar */
  .cal-wrap { background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: auto; max-height: calc(100vh - 150px); }
  .cal { display: grid; min-width: 560px; }
  .cal-h { position: sticky; top: 0; z-index: 2; padding: 10px 12px; font-weight: 500; border-bottom: 1px solid var(--line); border-left: 1px solid var(--line); background: var(--card); display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .cal-h:first-child { border-left: 0; }
  .cal-h .av { width: 24px; height: 24px; border-radius: 50%; background: var(--grad); color: #fff; font-size: 11.5px; display: grid; place-items: center; flex: none; }
  .cal-h small { color: var(--ink-3); font-weight: 400; }
  .cal-times, .cal-col { position: relative; }
  .cal-col { border-left: 1px solid var(--line); background: repeating-linear-gradient(to bottom, transparent 0, transparent 59px, var(--line) 59px, var(--line) 60px); }
  .cal-times span { position: absolute; right: 8px; font: 400 11px var(--mono); color: var(--ink-3); transform: translateY(-50%); }
  .now-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--red); z-index: 1; }
  .appt { position: absolute; left: 4px; right: 4px; border-radius: 9px; padding: 5px 8px; font-size: 12.5px; line-height: 1.3; overflow: hidden; background: var(--sky-bg); border-left: 3px solid var(--royal); cursor: pointer; }
  .appt:hover { filter: brightness(.97); }
  .appt b { font-weight: 500; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 16px; }
  .appt span { color: var(--ink-2); white-space: nowrap; }
  .appt .src { position: absolute; top: 5px; right: 6px; width: 13px; height: 13px; }
  .appt.held { background: repeating-linear-gradient(45deg, var(--sky-bg), var(--sky-bg) 6px, #fff 6px, #fff 12px); border-left-style: dashed; }
  .appt.paid::after { content: 'paid'; position: absolute; bottom: 4px; right: 6px; font: 500 10px var(--mono); color: var(--green); }
  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; font-size: 12px; color: var(--ink-3); padding: 0 10px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 11px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  tbody tr.click { cursor: pointer; }
  tbody tr.click:hover td { background: var(--bg); }
  .mono { font-family: var(--mono); font-size: 12.5px; }
  .muted { color: var(--ink-3); }
  .badge { display: inline-flex; align-items: center; gap: 6px; font: 500 12px Geist, sans-serif; padding: 2px 9px; border-radius: 99px; white-space: nowrap; }
  .b-confirmed { background: var(--green-bg); color: var(--green); }
  .b-held { background: var(--sky-bg); color: var(--royal); }
  .b-cancelled { background: var(--bg-2); color: var(--ink-2); }
  .b-expired { background: var(--amber-bg); color: var(--amber); }
  .b-error { background: var(--red-bg); color: var(--red); }
  .b-ok { background: var(--green-bg); color: var(--green); }
  .src-l { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .src-l img, .src-l .ini { width: 16px; height: 16px; flex: none; }
  .ai-ico { filter: invert(7%) sepia(18%) saturate(1800%) hue-rotate(196deg) brightness(92%); }
  .ini { border-radius: 5px; background: var(--bg-2); color: var(--ink-2); font: 600 9.5px var(--mono); display: grid; place-items: center; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .chip { border: 1px solid var(--line-2); background: var(--card); padding: 5px 12px; border-radius: 99px; cursor: pointer; font-size: 13px; color: var(--ink-2); }
  .chip.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  .feed-item { display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .feed-item:last-child { border-bottom: 0; }
  .agent-row { display: grid; grid-template-columns: 150px 1fr 70px; align-items: center; gap: 12px; padding: 7px 0; }
  .bar { height: 8px; border-radius: 99px; background: var(--bg-2); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 99px; background: var(--grad); }
  .agent-row .n { text-align: right; font: 500 13px var(--mono); }
  .agent-row .n small { display: block; color: var(--ink-3); font-weight: 400; font-size: 11px; }
  .empty { color: var(--ink-3); text-align: center; padding: 30px 10px; }
  /* Drawer + forms */
  .drawer-bg { position: fixed; inset: 0; background: rgba(11,16,32,.25); display: none; z-index: 30; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); background: var(--card); border-left: 1px solid var(--line); z-index: 31; transform: translateX(100%); transition: transform .25s ease; overflow-y: auto; padding: 24px; }
  .drawer.open { transform: none; }
  .drawer-bg.open { display: block; }
  .drawer-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 8px 12px; font-size: 14px; margin: 18px 0; }
  .kv dt { color: var(--ink-3); }
  .kv dd { margin: 0; }
  .field { display: grid; gap: 5px; margin-bottom: 12px; }
  .field label { font-size: 12.5px; color: var(--ink-3); }
  .field input, .field select, .field textarea { height: 38px; border: 1px solid var(--line-2); border-radius: 10px; padding: 0 11px; background: var(--card); width: 100%; }
  .field textarea { height: 70px; padding: 8px 11px; resize: vertical; }
  .two-f { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .times { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
  .times button { border: 1px solid var(--line-2); background: var(--card); border-radius: 99px; padding: 5px 11px; cursor: pointer; font: 500 13px var(--mono); }
  .times button small { font: 400 11px Geist, sans-serif; color: var(--ink-3); margin-left: 4px; }
  .times button.on { background: var(--royal); color: #fff; border-color: var(--royal); }
  .times button.on small { color: rgba(255,255,255,.8); }
  .check { display: flex; gap: 8px; align-items: center; font-size: 14px; margin: 4px 0 14px; }
  .err { color: var(--red); font-size: 13px; min-height: 18px; margin-bottom: 8px; }
  .toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 14px; z-index: 40; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .snip { font: 12.5px/1.5 var(--mono, ui-monospace, monospace); background: var(--bg-2, rgba(11,16,32,.04)); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 8px 0; white-space: pre-wrap; word-break: break-all; }
  .how { margin: 6px 0 0; padding-left: 18px; color: var(--ink-2); font-size: 13.5px; }
  .how li { margin: 3px 0; }
  .inst h3 { font-size: 14px; font-weight: 600; margin: 18px 0 2px; }
  .inst h3:first-of-type { margin-top: 6px; }
  .login { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
  .login .card { width: min(400px, 100%); padding: 28px; }
  .login input { width: 100%; height: 42px; border: 1px solid var(--line-2); border-radius: 10px; padding: 0 12px; margin: 16px 0 12px; }
  .login .alt { margin-top: 14px; font-size: 13px; color: var(--ink-3); }
  .login .alt a { color: var(--royal); }
  /* Settings */
  .set { display: grid; gap: 14px; max-width: 900px; padding-bottom: 70px; }
  .set .card h2 { margin-bottom: 4px; }
  .set .hint { color: var(--ink-3); font-size: 13px; margin: 0 0 14px; }
  .set-row { display: grid; gap: 10px; align-items: end; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .set-row:last-of-type { border-bottom: 0; }
  .set-row .field { margin: 0; }
  .st-row { grid-template-columns: 1fr 1fr auto; }
  .sv-row { grid-template-columns: 2fr 90px 110px auto; }
  .sv-row .sv-wide { grid-column: 1 / -1; }
  .hrs { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; align-items: center; }
  .hrs input { height: 36px; border: 1px solid var(--line-2); border-radius: 10px; padding: 0 11px; background: var(--card); width: 100%; font-family: var(--mono); font-size: 13px; }
  .staff-pick { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13.5px; }
  .staff-pick label { display: inline-flex; gap: 6px; align-items: center; }
  .three-f { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .steps { display: grid; gap: 6px; }
  .step { display: flex; gap: 10px; align-items: center; font-size: 14px; }
  .step i { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-2); flex: none; display: grid; place-items: center; font-style: normal; font-size: 12px; }
  .step.done i { background: var(--green); border-color: var(--green); color: #fff; }
  .step.done span { color: var(--ink-3); text-decoration: line-through; }
  .link-row { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); }
  .link-row:last-child { border-bottom: 0; }
  .link-row .l { flex: 1; min-width: 0; }
  .link-row .u { font: 400 12.5px var(--mono); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .savebar { position: fixed; bottom: 0; left: 220px; right: 0; padding: 12px 30px; background: rgba(248,248,245,.92); backdrop-filter: blur(6px); border-top: 1px solid var(--line); display: flex; gap: 12px; align-items: center; z-index: 5; }
  .savebar .err { margin: 0; flex: 1; }
  @media (max-width: 760px) { .savebar { left: 0; padding: 10px 14px; } .sv-row, .st-row, .three-f { grid-template-columns: 1fr 1fr; } }
  .hidden { display: none !important; }
  @media (max-width: 1000px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .two { grid-template-columns: 1fr; } }
  @media (max-width: 760px) {
    .app { grid-template-columns: 1fr; }
    aside { position: static; height: auto; flex-direction: row; overflow-x: auto; padding: 10px; border-right: 0; border-bottom: 1px solid var(--line); }
    .brand { padding: 4px 10px 4px 4px; } .venue-name, .aside-foot, .nav-sep { display: none; } .nav { width: auto; white-space: nowrap; }
    main { padding: 16px 14px 48px; } .hide-sm { display: none; }
  }
</style>
</head>
<body>
<div id="login" class="login hidden">
  <div class="card">
    <h1>OpenBooking Studio</h1>
    <div class="muted" id="login-msg">Enter your Studio token to continue.</div>
    <input id="email" class="hidden" type="email" placeholder="Email" autocomplete="username" style="margin-bottom:0" />
    <input id="token" type="password" placeholder="Studio token" autocomplete="current-password" />
    <div class="err" id="login-err"></div>
    <button class="btn btn-primary" id="login-btn" style="width:100%;justify-content:center">Open Studio</button>
    <div class="alt hidden" id="login-forgot"><a id="forgot-link" href="#">Forgot your password?</a></div>
    <div class="alt hidden" id="login-alt">New here? <a id="signup-link" href="#">Create your free account</a></div>
  </div>
</div>

<div id="app" class="app hidden">
  <aside>
    <div class="brand"><i><svg width="12" height="12" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></i>OpenBooking</div>
    <div class="venue-name" id="venue-name"></div>
    <button class="nav active" data-view="calendar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>Calendar</button>
    <button class="nav" data-view="bookings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>Bookings</button>
    <button class="nav" data-view="customers"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 010 8M22 21c0-3-2-5-5-5.5"/></svg>Customers</button>
    <button class="nav" data-view="services"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>Services &amp; staff</button>
    <div class="nav-sep"></div>
    <button class="nav" data-view="insights"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Insights</button>
    <button class="nav" data-view="activity"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>Agent log</button>
    <button class="nav hidden" data-view="settings" id="nav-settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>Settings</button>
    <div class="aside-foot">Open source · <a href="https://openbooking.sh" target="_blank" rel="noopener">openbooking.sh</a><span id="logout-wrap" class="hidden"> · <a href="#" id="logout">Log out</a></span></div>
  </aside>
  <main>
    <header class="top">
      <div><h1 id="title">Calendar</h1><div class="sub" id="subtitle"></div></div>
      <div class="row" id="actions"></div>
    </header>
    <section id="view-calendar"><div class="cal-wrap"><div id="cal"></div></div></section>
    <section id="view-bookings" class="hidden">
      <div class="chips" id="status-chips">
        <button class="chip on" data-status="">All</button>
        <button class="chip" data-status="confirmed">Confirmed</button>
        <button class="chip" data-status="held">Held</button>
        <button class="chip" data-status="cancelled">Cancelled</button>
        <button class="chip" data-status="expired">Expired</button>
      </div>
      <div class="card" style="padding:12px 8px"><div id="bookings"></div></div>
    </section>
    <section id="view-customers" class="hidden"><div class="card" style="padding:12px 8px"><div id="customers"></div></div></section>
    <section id="view-services" class="hidden">
      <div class="card" style="padding:12px 8px"><h2 style="padding:0 10px">Services</h2><div id="offerings"></div></div>
      <div class="card" style="padding:12px 8px;margin-top:14px"><h2 style="padding:0 10px">Staff &amp; resources</h2><div id="resources"></div></div>
    </section>
    <section id="view-insights" class="hidden">
      <div class="grid kpis" id="kpis"></div>
      <div class="grid two">
        <div class="card"><h2>Booking channels <span>where bookings came from</span></h2><div id="agents"></div></div>
        <div class="card"><h2>Latest agent calls</h2><div id="feed"></div></div>
      </div>
    </section>
    <section id="view-activity" class="hidden"><div class="card" style="padding:12px 8px"><div id="activity"></div></div></section>
    <section id="view-settings" class="hidden"><div class="set" id="settings"></div></section>
  </main>
</div>

<div class="drawer-bg" id="drawer-bg"></div>
<div class="drawer" id="drawer"></div>
<div class="toast" id="toast"></div>

<script>
(function () {
  var base = location.pathname.replace(/\\/$/, '');
  var token = '';
  try { token = sessionStorage.getItem('ob-studio-token') || ''; } catch (e) {}
  var tz = 'UTC';
  var currency = '';
  var view = 'calendar';
  var statusFilter = '';
  var calDate = null;
  var catalog = { offerings: [], resources: [] };
  var timer = null;

  var LOGOS = {
    'Claude': 'https://cdn.jsdelivr.net/npm/simple-icons@16.33.0/icons/anthropic.svg',
    'ChatGPT': 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.95.1/icons/openai.svg',
    'Gemini': 'https://cdn.jsdelivr.net/npm/simple-icons@16.33.0/icons/googlegemini.svg',
    'Perplexity': 'https://cdn.jsdelivr.net/npm/simple-icons@16.33.0/icons/perplexity.svg',
    'Mistral': 'https://cdn.jsdelivr.net/npm/simple-icons@16.33.0/icons/mistralai.svg'
  };

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (token) opts.headers.authorization = 'Bearer ' + token;
    return fetch(base + '/api' + path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401) { showLogin(j.error || {}); throw new Error('unauthorized'); }
        if (!r.ok) throw new Error((j.error && j.error.message) || 'Request failed');
        return j;
      });
    });
  }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2600); }
  function parts(iso) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function localDate(iso) { var p = parts(iso); return p.year + '-' + p.month + '-' + p.day; }
  function minutes(iso) { var p = parts(iso); return Number(p.hour) * 60 + Number(p.minute); }
  function fmtTime(iso) { var p = parts(iso); return p.hour + ':' + p.minute; }
  function fmtDate(iso) { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)); }
  function fmtDay(d) { return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z')); }
  function addDays(d, n) { var t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function money(m) { return m ? (m.amount / 100).toLocaleString('en').replace(/,/g, ' ') + ' ' + esc(m.currency) : ''; }
  function amount(n, cur) { return (n / 100).toLocaleString('en').replace(/,/g, ' ') + ' ' + esc(cur || currency); }
  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago';
  }
  function badge(status) { return '<span class="badge b-' + esc(status) + '">' + esc(status) + '</span>'; }
  function source(name) {
    var n = name || 'Direct';
    var icon = LOGOS[n] ? '<img class="ai-ico" src="' + LOGOS[n] + '" alt="" />' : '<span class="ini">' + esc(n.charAt(0).toUpperCase()) + '</span>';
    return '<span class="src-l">' + icon + esc(n) + '</span>';
  }
  var OPS = { search: 'searched availability', hold: 'held a slot', confirm: 'confirmed a booking', cancel: 'cancelled', get: 'looked up a booking', update: 'updated a booking', list: 'listed bookings' };

  // Login: a shared Studio token (self-hosted), or email + password when the host says so
  // (hosted OpenBooking answers 401 with login: 'password' and where to log in).
  var login = { mode: 'token', url: '', signup: '' };
  function saveToken(t) { token = t; try { if (t) sessionStorage.setItem('ob-studio-token', t); else sessionStorage.removeItem('ob-studio-token'); } catch (e) {} }
  function showLogin(err) {
    $('app').classList.add('hidden'); $('login').classList.remove('hidden');
    if (err.login === 'password') {
      login = { mode: 'password', url: err.login_url || '', signup: err.signup_url || '' };
      $('email').classList.remove('hidden');
      $('token').placeholder = 'Password';
      $('login-btn').textContent = 'Log in';
      $('login-msg').textContent = 'Log in to manage your bookings.';
      if (login.signup) { $('signup-link').href = login.signup; $('login-alt').classList.remove('hidden'); }
      if (err.reset_url) { $('forgot-link').href = err.reset_url; $('login-forgot').classList.remove('hidden'); }
    } else if (err.message) {
      $('login-msg').textContent = err.message;
    }
  }
  $('login-btn').onclick = function () {
    $('login-err').textContent = '';
    var go = login.mode === 'password'
      ? fetch(login.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('token').value }) })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || 'Login failed'); saveToken(j.token); }); })
      : Promise.resolve(saveToken($('token').value.trim()));
    go.then(start).catch(function (e) { $('login-err').textContent = e.message === 'unauthorized' ? (login.mode === 'password' ? 'Wrong email or password.' : 'That token did not work.') : e.message; });
  };
  $('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('login-btn').click(); });
  $('logout').onclick = function (e) { e.preventDefault(); saveToken(''); location.hash = ''; location.reload(); };

  document.querySelectorAll('.nav').forEach(function (b) { b.onclick = function () { go(b.getAttribute('data-view')); }; });
  document.querySelectorAll('#status-chips .chip').forEach(function (c) {
    c.onclick = function () {
      document.querySelectorAll('#status-chips .chip').forEach(function (x) { x.classList.toggle('on', x === c); });
      statusFilter = c.getAttribute('data-status'); loadBookings();
    };
  });

  var TITLES = { calendar: 'Calendar', bookings: 'Bookings', customers: 'Customers', services: 'Services & staff', insights: 'Insights', activity: 'Agent log', settings: 'Settings' };
  var VIEWS = ['calendar', 'bookings', 'customers', 'services', 'insights', 'activity', 'settings'];
  function go(v) {
    view = v;
    if (history.replaceState) history.replaceState(null, '', v === 'calendar' ? location.pathname + location.search : '#' + v);
    document.querySelectorAll('.nav').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === v); });
    VIEWS.forEach(function (x) { $('view-' + x).classList.toggle('hidden', x !== v); });
    $('title').textContent = TITLES[v];
    renderActions();
    refresh();
  }
  function refresh() {
    if (view === 'calendar') return loadCalendar();
    if (view === 'bookings') return loadBookings();
    if (view === 'customers') return loadCustomers();
    if (view === 'services') return loadServices();
    if (view === 'insights') return loadInsights();
    if (view === 'activity') return loadActivity();
    if (view === 'settings') return loadSettings();
  }

  function renderActions() {
    var a = $('actions');
    if (view === 'calendar') {
      a.innerHTML = '<button class="btn btn-sm" id="d-prev" aria-label="Previous day">&#8249;</button><button class="btn btn-sm" id="d-today">Today</button><button class="btn btn-sm" id="d-next" aria-label="Next day">&#8250;</button><button class="btn btn-primary" id="new-booking">+ New booking</button>';
      $('d-prev').onclick = function () { calDate = addDays(calDate, -1); loadCalendar(); };
      $('d-next').onclick = function () { calDate = addDays(calDate, 1); loadCalendar(); };
      $('d-today').onclick = function () { calDate = null; loadCalendar(); };
    } else if (view === 'bookings') {
      a.innerHTML = '<button class="btn btn-primary" id="new-booking">+ New booking</button>';
    } else { a.innerHTML = ''; }
    var nb = $('new-booking'); if (nb) nb.onclick = function () { newBooking(); };
  }

  // ---------------------------------------------------------------- Calendar
  function loadCalendar() {
    return api('/calendar' + (calDate ? '?date=' + calDate : '')).then(function (d) {
      calDate = d.date;
      var paid = 0, count = d.bookings.length;
      d.bookings.forEach(function (b) { if (b.status === 'confirmed' && b.slot.price) paid += b.slot.price.amount; });
      $('subtitle').textContent = fmtDay(d.date) + ' · ' + count + ' booking' + (count === 1 ? '' : 's') + (paid ? ' · ' + amount(paid) : '');
      var cols = d.resources.length ? d.resources.map(function (r) { return { id: r.id, name: r.name, kind: r.kind, cap: r.capacity }; }) : [{ id: '_all', name: 'Bookings', kind: '' }];
      var startH = 8, endH = 20;
      d.bookings.forEach(function (b) {
        startH = Math.min(startH, Math.floor(minutes(b.slot.start) / 60));
        endH = Math.max(endH, Math.ceil(minutes(b.slot.end) / 60));
      });
      var top = startH * 60, height = (endH - startH) * 60;
      var h = '<div class="cal" style="grid-template-columns:52px repeat(' + cols.length + ', minmax(120px, 1fr))"><div class="cal-h"></div>';
      cols.forEach(function (c) {
        var sub = c.kind === 'table' && c.cap ? '<small>' + c.cap.min + '-' + c.cap.max + ' seats</small>' : '';
        h += '<div class="cal-h"><span class="av">' + esc(c.name.charAt(0)) + '</span>' + esc(c.name) + sub + '</div>';
      });
      h += '<div class="cal-times" style="height:' + height + 'px">';
      for (var t = top + 60; t < top + height; t += 60) h += '<span style="top:' + (t - top) + 'px">' + hm(t) + '</span>';
      h += '</div>';
      var nowIso = new Date().toISOString();
      var nowTop = localDate(nowIso) === d.date ? minutes(nowIso) - top : -1;
      cols.forEach(function (c) {
        h += '<div class="cal-col" style="height:' + height + 'px">';
        if (nowTop > 0 && nowTop < height) h += '<div class="now-line" style="top:' + nowTop + 'px"></div>';
        d.bookings.filter(function (b) {
          var rid = b.slot.resource && b.slot.resource.id;
          return c.id === '_all' || rid === c.id || (!rid && cols[0] === c);
        }).forEach(function (b) {
          var s = minutes(b.slot.start), e = minutes(b.slot.end);
          var name = b.customer ? b.customer.first_name + ' ' + b.customer.last_name : 'Held, no name yet';
          var party = b.slot.party_size.total > 1 ? ' · ' + b.slot.party_size.total + ' guests' : '';
          h += '<div class="appt' + (b.status === 'held' ? ' held' : '') + (b.payment.status === 'paid' ? ' paid' : '') + '" data-id="' + esc(b.booking_id) + '" style="top:' + (s - top + 1) + 'px;height:' + Math.max(22, e - s - 2) + 'px">' +
            (LOGOS[b.booked_via] ? '<img class="src ai-ico" src="' + LOGOS[b.booked_via] + '" alt="' + esc(b.booked_via) + '" />' : '') +
            '<b>' + esc(name) + '</b><span>' + fmtTime(b.slot.start) + ' · ' + esc(b.slot.offering.name) + party + '</span></div>';
        });
        h += '</div>';
      });
      $('cal').innerHTML = h + '</div>';
      $('cal').querySelectorAll('.appt').forEach(function (el) { el.onclick = function () { openBooking(el.getAttribute('data-id')); }; });
    });
  }

  // ---------------------------------------------------------------- Lists
  function bookingTable(list) {
    if (!list.length) return '<div class="empty">No bookings yet.</div>';
    var h = '<table><thead><tr><th>When</th><th>Customer</th><th class="hide-sm">Service</th><th class="hide-sm">With</th><th>Status</th><th>Source</th></tr></thead><tbody>';
    list.forEach(function (b) {
      var c = b.customer;
      h += '<tr class="click" data-id="' + esc(b.booking_id) + '"><td><b>' + fmtTime(b.slot.start) + '</b> <span class="muted">' + fmtDate(b.slot.start) + '</span></td>' +
        '<td>' + (c ? esc(c.first_name + ' ' + c.last_name) : '<span class="muted">Not given yet</span>') + '</td>' +
        '<td class="hide-sm">' + esc(b.slot.offering.name) + (b.slot.party_size.total > 1 ? ' <span class="muted">· ' + b.slot.party_size.total + '</span>' : '') + '</td>' +
        '<td class="hide-sm">' + esc(b.slot.resource ? b.slot.resource.label : '') + '</td>' +
        '<td>' + badge(b.status) + '</td><td>' + source(b.booked_via) + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  function bindRows(el) { el.querySelectorAll('tr.click').forEach(function (tr) { tr.onclick = function () { openBooking(tr.getAttribute('data-id')); }; }); }
  function loadBookings() {
    $('subtitle').textContent = 'All bookings, newest first';
    return api('/bookings' + (statusFilter ? '?status=' + statusFilter : '')).then(function (d) {
      $('bookings').innerHTML = bookingTable(d.bookings); bindRows($('bookings'));
    }).catch(function (e) { if (e.message !== 'unauthorized') $('bookings').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function loadCustomers() {
    return api('/customers').then(function (d) {
      $('subtitle').textContent = d.customers.length + ' customer' + (d.customers.length === 1 ? '' : 's');
      if (!d.customers.length) { $('customers').innerHTML = '<div class="empty">Customers appear here after their first booking.</div>'; return; }
      var h = '<table><thead><tr><th>Name</th><th class="hide-sm">Email</th><th class="hide-sm">Phone</th><th>Bookings</th><th class="hide-sm">Spend</th><th>Next visit</th><th class="hide-sm">First booked via</th></tr></thead><tbody>';
      d.customers.forEach(function (c) {
        h += '<tr><td><b>' + esc(c.name) + '</b></td><td class="hide-sm">' + esc(c.email || '-') + '</td><td class="hide-sm">' + esc(c.phone_number || '-') + '</td><td>' + c.bookings + '</td><td class="hide-sm">' +
          (c.spend ? amount(c.spend, c.currency) : '<span class="muted">-</span>') + '</td><td>' + (c.next_visit ? fmtDate(c.next_visit) + ' ' + fmtTime(c.next_visit) : '<span class="muted">-</span>') +
          '</td><td class="hide-sm">' + source(c.first_source) + '</td></tr>';
      });
      $('customers').innerHTML = h + '</tbody></table>';
    });
  }
  function loadServices() {
    $('subtitle').textContent = 'What customers and AI assistants can book';
    return api('/catalog').then(function (d) {
      catalog = d;
      $('offerings').innerHTML = d.offerings.length ? '<table><thead><tr><th>Service</th><th>Duration</th><th>Price</th><th class="hide-sm">Description</th></tr></thead><tbody>' +
        d.offerings.map(function (o) { return '<tr><td><b>' + esc(o.name) + '</b></td><td>' + o.duration_minutes + ' min</td><td>' + (o.price_per_person ? money(o.price_per_person) : '<span class="muted">At venue</span>') + '</td><td class="hide-sm muted">' + esc(o.description || '') + '</td></tr>'; }).join('') + '</tbody></table>'
        : '<div class="empty">This booking system does not list its services.</div>';
      $('resources').innerHTML = d.resources.length ? '<table><thead><tr><th>Name</th><th>Type</th><th>Capacity</th><th class="hide-sm">Tags</th></tr></thead><tbody>' +
        d.resources.map(function (r) { return '<tr><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.kind) + '</td><td>' + (r.capacity.max > 1 ? r.capacity.min + '-' + r.capacity.max : '1') + '</td><td class="hide-sm muted">' + esc((r.tags || []).join(', ')) + '</td></tr>'; }).join('') + '</tbody></table>'
        : '<div class="empty">This booking system does not list its staff or resources.</div>';
    });
  }
  function loadInsights() {
    $('subtitle').textContent = 'Today and the last 24 hours';
    return api('/overview').then(function (d) {
      var k = d.kpis;
      var pct = function (x) { return x == null ? '-' : Math.round(x * 100) + '%'; };
      var cards = [['Upcoming bookings', k.upcoming_confirmed], ['Booked today', k.confirmed_today], ['Open holds', k.holds_open], ['Hold to booking', pct(k.hold_to_booking_rate)]];
      $('kpis').innerHTML = cards.map(function (c) { return '<div class="card kpi"><div class="l">' + c[0] + '</div><div class="v">' + esc(c[1]) + '</div></div>'; }).join('');
      var max = Math.max.apply(null, [1].concat(d.agents.map(function (a) { return a.bookings; })));
      $('agents').innerHTML = d.agents.length ? d.agents.map(function (a) {
        return '<div class="agent-row">' + source(a.agent) + '<div class="bar"><i style="width:' + Math.round((a.bookings / max) * 100) + '%"></i></div><div class="n">' + a.bookings + '<small>' + a.calls + ' calls</small></div></div>';
      }).join('') : '<div class="empty">No bookings yet.</div>';
      return api('/activity?limit=8');
    }).then(function (a) { $('feed').innerHTML = feed(a.activity); });
  }
  function feed(list) {
    if (!list.length) return '<div class="empty">No agent calls yet.</div>';
    return list.map(function (e) {
      var res = e.ok ? '<span class="badge b-ok">' + (e.replayed ? 'replayed' : 'ok') + '</span>' : '<span class="badge b-error">' + esc(e.error_code) + '</span>';
      return '<div class="feed-item"><span class="muted mono">' + ago(e.at) + '</span><span class="row" style="gap:8px">' + source(e.agent) + '<span class="muted">' + esc(OPS[e.operation] || e.operation) + '</span></span>' + res + '</div>';
    }).join('');
  }
  function loadActivity() {
    $('subtitle').textContent = 'Every call from AI assistants and Studio';
    return api('/activity?limit=200').then(function (d) {
      if (!d.activity.length) { $('activity').innerHTML = '<div class="empty">No agent activity yet.</div>'; return; }
      var h = '<table><thead><tr><th>Time</th><th>Who</th><th class="hide-sm">Protocol</th><th>Action</th><th>Result</th></tr></thead><tbody>';
      d.activity.forEach(function (e) {
        h += '<tr' + (e.booking_id ? ' class="click" data-id="' + esc(e.booking_id) + '"' : '') + '><td class="mono muted">' + fmtTime(e.at) + '</td><td>' + source(e.agent) + '</td><td class="hide-sm mono muted">' + esc(e.protocol) + '</td><td>' + esc(OPS[e.operation] || e.operation) + '</td><td>' +
          (e.ok ? '<span class="badge b-ok">' + (e.replayed ? 'replayed' : 'ok') + '</span>' : '<span class="badge b-error">' + esc(e.error_code) + '</span>') + '</td></tr>';
      });
      $('activity').innerHTML = h + '</tbody></table>'; bindRows($('activity'));
    });
  }

  // ---------------------------------------------------------------- Drawer
  function openDrawer(html) { $('drawer').innerHTML = html; $('drawer').classList.add('open'); $('drawer-bg').classList.add('open'); }
  function closeDrawer() { $('drawer').classList.remove('open'); $('drawer-bg').classList.remove('open'); }
  $('drawer-bg').onclick = closeDrawer;

  function openBooking(id) {
    api('/bookings/' + encodeURIComponent(id)).then(function (d) {
      var b = d.booking, c = b.customer, p = b.slot.cancellation_policy;
      var rows = [
        ['Status', badge(b.status)],
        ['When', fmtDate(b.slot.start) + ', ' + fmtTime(b.slot.start) + ' - ' + fmtTime(b.slot.end)],
        ['Service', esc(b.slot.offering.name) + (b.slot.party_size.total > 1 ? ' · ' + b.slot.party_size.total + ' guests' : '')],
        ['With', esc(b.slot.resource ? b.slot.resource.label : '-')],
        ['Customer', c ? esc(c.first_name + ' ' + c.last_name) : '<span class="muted">Not given</span>'],
        ['Email', c && c.email ? esc(c.email) : '<span class="muted">-</span>'],
        ['Phone', c && c.phone_number ? esc(c.phone_number) : '<span class="muted">-</span>'],
        ['Notes', b.notes ? esc(b.notes) : '<span class="muted">-</span>'],
        ['Price', b.slot.price ? money(b.slot.price) : '<span class="muted">At venue</span>'],
        ['Deposit', b.slot.deposit ? money(b.slot.deposit.amount) + ' (' + esc(b.payment.status) + ')' : '<span class="muted">None</span>'],
        ['Source', source(b.booked_via)],
        ['Code', b.confirmation_code ? '<span class="mono">' + esc(b.confirmation_code) + '</span>' : '<span class="muted">-</span>'],
        ['Cancellation', esc(p.description)]
      ];
      if (b.status === 'held' && b.expires_at) rows.splice(1, 0, ['Hold expires', fmtTime(b.expires_at)]);
      if (b.cancellation) rows.push(['Cancelled', esc(b.cancellation.reason || '') + (b.cancellation.fee ? ' · fee ' + money(b.cancellation.fee) : '')]);
      var canCancel = b.status === 'held' || b.status === 'confirmed';
      openDrawer('<div class="drawer-head"><h1 style="font-size:20px">Booking</h1><button class="btn btn-sm" id="dr-close">Close</button></div>' +
        '<div class="mono muted">' + esc(b.booking_id) + '</div>' +
        '<dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
        (canCancel ? '<button class="btn btn-danger" id="dr-cancel">' + (b.status === 'held' ? 'Release hold' : 'Cancel booking') + '</button>' : '') +
        (d.activity.length ? '<h2 style="font-size:15px;font-weight:500;margin:28px 0 8px">History</h2>' + d.activity.map(function (e) {
          return '<div class="feed-item"><span class="muted mono">' + fmtTime(e.at) + '</span><span class="row" style="gap:8px">' + source(e.agent) + '<span class="muted">' + esc(OPS[e.operation] || e.operation) + '</span></span>' +
            (e.ok ? '' : '<span class="badge b-error">' + esc(e.error_code) + '</span>') + '</div>';
        }).join('') : ''));
      $('dr-close').onclick = closeDrawer;
      if (canCancel) $('dr-cancel').onclick = function () {
        if (!confirm('Cancel this booking? The customer is not notified automatically.')) return;
        api('/bookings/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: JSON.stringify({}) })
          .then(function () { closeDrawer(); toast('Booking cancelled'); refresh(); })
          .catch(function (e) { alert(e.message); });
      };
    });
  }

  function newBooking() {
    var load = catalog.offerings.length ? Promise.resolve(catalog) : api('/catalog').then(function (d) { catalog = d; return d; });
    load.then(function (cat) {
      var opts = cat.offerings.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + ' · ' + o.duration_minutes + ' min' + (o.price_per_person ? ' · ' + money(o.price_per_person) : '') + '</option>'; }).join('');
      var isTables = cat.resources.some(function (r) { return r.capacity && r.capacity.max > 1; });
      openDrawer('<div class="drawer-head"><h1 style="font-size:20px">New booking</h1><button class="btn btn-sm" id="nb-close">Close</button></div>' +
        '<div class="muted" style="margin-bottom:18px">For phone calls and walk-ins.</div>' +
        (opts ? '<div class="field"><label>Service</label><select id="nb-service">' + opts + '</select></div>' : '') +
        '<div class="two-f"><div class="field"><label>Date</label><input type="date" id="nb-date" value="' + esc(calDate || '') + '" /></div>' +
        '<div class="field"><label>' + (isTables ? 'Guests' : 'People') + '</label><input type="number" id="nb-party" min="1" max="50" value="' + (isTables ? 2 : 1) + '" /></div></div>' +
        '<button class="btn" id="nb-find">Find free times</button><div id="nb-times" class="times" style="margin-top:12px"></div>' +
        '<div id="nb-form" class="hidden">' +
          '<div class="two-f"><div class="field"><label>First name</label><input id="nb-first" /></div><div class="field"><label>Last name</label><input id="nb-last" /></div></div>' +
          '<div class="two-f"><div class="field"><label>Phone</label><input id="nb-phone" placeholder="+47..." /></div><div class="field"><label>Email</label><input id="nb-email" type="email" /></div></div>' +
          '<div class="field"><label>Notes</label><textarea id="nb-notes"></textarea></div>' +
          '<label class="check hidden" id="nb-dep-wrap"><input type="checkbox" id="nb-dep" /> <span id="nb-dep-label">Deposit collected</span></label>' +
          '<div class="err" id="nb-err"></div>' +
          '<button class="btn btn-primary" id="nb-save">Create booking</button>' +
        '</div>');
      $('nb-close').onclick = closeDrawer;
      var chosen = null;
      $('nb-find').onclick = function () {
        var q = '?date=' + encodeURIComponent($('nb-date').value) + '&party_size=' + encodeURIComponent($('nb-party').value) + ($('nb-service') ? '&offering_id=' + encodeURIComponent($('nb-service').value) : '');
        $('nb-times').innerHTML = '<span class="muted">Checking…</span>';
        api('/availability' + q).then(function (d) {
          if (!d.slots.length) { $('nb-times').innerHTML = '<span class="muted">No free times that day.</span>'; return; }
          $('nb-times').innerHTML = d.slots.map(function (s, i) {
            return '<button data-i="' + i + '">' + fmtTime(s.start) + (s.resource ? '<small>' + esc(s.resource.label) + '</small>' : '') + '</button>';
          }).join('');
          $('nb-times').querySelectorAll('button').forEach(function (btn) {
            btn.onclick = function () {
              $('nb-times').querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === btn); });
              chosen = d.slots[Number(btn.getAttribute('data-i'))];
              $('nb-form').classList.remove('hidden');
              var dep = chosen.deposit && chosen.deposit.due === 'at_confirmation';
              $('nb-dep-wrap').classList.toggle('hidden', !dep);
              if (dep) $('nb-dep-label').textContent = 'Deposit of ' + (chosen.deposit.amount.amount / 100) + ' ' + chosen.deposit.amount.currency + ' collected';
            };
          });
        }).catch(function (e) { $('nb-times').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
      };
      $('nb-save').onclick = function () {
        if (!chosen) return;
        var customer = { first_name: $('nb-first').value.trim(), last_name: $('nb-last').value.trim() };
        if ($('nb-phone').value.trim()) customer.phone_number = $('nb-phone').value.trim();
        if ($('nb-email').value.trim()) customer.email = $('nb-email').value.trim();
        $('nb-err').textContent = '';
        $('nb-save').disabled = true;
        api('/bookings', { method: 'POST', body: JSON.stringify({ slot_id: chosen.slot_id, customer: customer, notes: $('nb-notes').value.trim() || undefined, deposit_collected: $('nb-dep').checked }) })
          .then(function (r) {
            closeDrawer();
            calDate = localDate(r.booking.slot.start);
            toast('Booked ' + customer.first_name + ' at ' + fmtTime(r.booking.slot.start));
            if (view !== 'calendar') go('calendar'); else loadCalendar();
          })
          .catch(function (e) { $('nb-err').textContent = e.message; $('nb-save').disabled = false; });
      };
    });
  }

  // ---------------------------------------------------------------- Settings
  var SV = null;     // last SettingsView from the server
  var draft = null;  // settings being edited
  var CATEGORIES = [['hair_salon', 'Hair salon'], ['barber', 'Barber'], ['beauty', 'Beauty & nails'], ['physiotherapist', 'Physiotherapy'], ['therapist', 'Therapy & counselling'], ['personal_trainer', 'Personal training'], ['tutor', 'Tutoring'], ['other', 'Other']];
  var DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

  function loadSettings() {
    $('subtitle').textContent = 'What customers and AI assistants see and can book';
    return api('/settings').then(function (d) {
      SV = d; draft = JSON.parse(JSON.stringify(d.settings)); renderSettings();
      if (/[?&]google=connected/.test(location.search)) toast('Google Calendar connected');
      if (/[?&]verified=yes/.test(location.search)) toast('Email confirmed');
      if (/[?&]verified=expired/.test(location.search)) toast('That link expired. Send a new one from Settings.');
    });
  }
  function slug(s) { return String(s).toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a').normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item'; }
  function uniqueId(name, taken) { var b = slug(name), id = b, n = 2; while (taken.indexOf(id) >= 0) id = b.slice(0, 36) + '-' + n++; return id; }
  function field(label, id, value, attrs) { return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + ' /></div>'; }
  function check(id, on, label) { return '<label class="check"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' /> ' + label + '</label>'; }
  function hoursText(list) { return (list || []).map(function (p) { return p.open + '-' + p.close; }).join(', '); }
  function major(n) { return n == null ? '' : String(n / 100); }

  function renderSettings() {
    var s = draft, p = s.profile, a = p.address || {}, g = SV.integrations && SV.integrations.google;
    var anyHours = DAYS.some(function (d) { return (s.opening_hours[d[0]] || []).length; });
    var steps = [
      ['Add your address and phone number', !!(a.street_address && p.phone_number)],
      ['Set your opening hours', anyHours],
      ['Add your staff', s.staff.length > 0],
      ['Add your services and prices', s.services.length > 0]
    ];
    if (g && g.available) steps.push(['Connect Google Calendar', g.connected]);
    var unverified = SV.account && SV.account.email_verified === false;
    if (SV.account && SV.account.email_verified !== undefined) steps.unshift(['Confirm your email', !unverified]);
    var h = '';
    h += '<div class="card"><h2>Get bookable</h2><div class="steps">' + steps.map(function (x) { return '<div class="step' + (x[1] ? ' done' : '') + '"><i>' + (x[1] ? '&#10003;' : '') + '</i><span>' + esc(x[0]) + '</span></div>'; }).join('') + '</div>' +
      (unverified ? '<p class="hint" style="margin-top:12px">We emailed a link to <b>' + esc(SV.account.email) + '</b>. Confirm it to be listed in ChatGPT and Claude. <a href="#" id="resend-verify">Send it again</a></p>' : '') + '</div>';
    if (SV.links && SV.links.length) {
      h += '<div class="card"><h2>Share your booking links</h2><p class="hint">Post these on Instagram, Google and your website so customers can book you through ChatGPT, Claude and Gemini.</p>' + SV.links.map(function (l, i) {
        return '<div class="link-row"><div class="l"><b>' + esc(l.label) + '</b>' + (l.hint ? ' <span class="muted">· ' + esc(l.hint) + '</span>' : '') + '<div class="u">' + esc(l.url) + '</div></div><button class="btn btn-sm" data-copy="' + i + '">Copy</button><a class="btn btn-sm" href="' + esc(l.url) + '" target="_blank" rel="noopener">Open</a></div>';
      }).join('') + '</div>';
    }
    var I = SV.install;
    if (I) {
      h += '<div class="card inst"><h2>Get found on Google and your website</h2><p class="hint">Three places, a few minutes each. Customers can then book you from Google, your own site and any AI assistant.</p>' +
        '<h3>1. Google (Search and Maps)</h3><ol class="how"><li>Open <a href="https://business.google.com/" target="_blank" rel="noopener">Google Business Profile</a> and choose <b>Bookings</b> (or <b>Edit profile</b>, then <b>Booking links</b>).</li><li>Paste your booking page link: <button class="btn btn-sm" data-copy-text="' + esc(I.booking_page) + '">Copy link</button></li><li>A <b>Book</b> button shows up on Google within a day or two.</li></ol>' +
        '<h3>2. Your website</h3><p class="hint">Paste this one line into your site. It adds a Book button, lets AI browsers book you right on your site, and tells search engines what you offer.</p>' +
        '<div class="snip">' + esc(I.snippet) + '</div><button class="btn btn-sm" data-copy-text="' + esc(I.snippet) + '">Copy code</button>' +
        '<ol class="how"><li><b>Wix:</b> Settings, Custom code, Add custom code, place it in Body - end, all pages.</li><li><b>Squarespace:</b> Settings, Advanced, Code injection, Footer.</li><li><b>WordPress:</b> install the free WPCode plugin, then Code snippets, Header &amp; Footer, Footer.</li><li><b>Webflow:</b> Site settings, Custom code, Footer code.</li><li><b>Shopify:</b> Online Store, Themes, Edit code, theme.liquid, just before &lt;/body&gt;.</li><li><b>No website?</b> Skip this; your booking page is your website.</li></ol>' +
        '<h3>3. Instagram and Facebook</h3><ol class="how"><li>Instagram: Edit profile, Links, add your booking page link.</li><li>Facebook: Edit page, Add action button, Book now, paste the same link.</li></ol></div>';
    }
    h += '<div class="card"><h2>Business</h2><p class="hint">Shown to customers and AI assistants.</p>' +
      '<div class="two-f">' + field('Name', 's-name', p.name) +
      '<div class="field"><label for="s-cat">Type of business</label><select id="s-cat">' + CATEGORIES.map(function (c) { return '<option value="' + c[0] + '"' + (p.category === c[0] ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="field"><label for="s-desc">Description</label><textarea id="s-desc" maxlength="1000">' + esc(p.description || '') + '</textarea></div>' +
      '<div class="three-f">' + field('Phone', 's-phone', p.phone_number, 'placeholder="+47..."') + field('Contact email', 's-email', p.email, 'type="email"') + field('Website', 's-web', p.website, 'placeholder="https://"') + '</div>' +
      '<div class="two-f">' + field('Street address', 's-street', a.street_address) + field('Postal code', 's-zip', a.postal_code) + '</div>' +
      '<div class="three-f">' + field('City', 's-city', a.address_locality) + field('Country (code)', 's-country', a.address_country, 'placeholder="NO" maxlength="2"') + field('Currency', 's-cur', p.currency, 'maxlength="3"') + '</div>' +
      field('Time zone', 's-tz', p.timezone, 'placeholder="Europe/Oslo"') + '</div>';
    h += '<div class="card"><h2>Opening hours</h2><p class="hint">For example 09:00-17:00, or 09:00-12:00, 13:00-18:00 with a lunch break. Leave empty when closed.</p><div class="hrs">' +
      DAYS.map(function (d) { return '<label for="h-' + d[0] + '">' + d[1] + '</label><input id="h-' + d[0] + '" value="' + esc(hoursText(s.opening_hours[d[0]])) + '" placeholder="Closed" />'; }).join('') + '</div>' +
      '<div class="field" style="margin-top:14px"><label for="s-closed">Closed on these dates (YYYY-MM-DD, comma separated)</label><input id="s-closed" value="' + esc((s.closed_dates || []).join(', ')) + '" /></div></div>';
    var cals = g && g.connected && g.calendars ? g.calendars : null;
    h += '<div class="card"><h2>Staff</h2><p class="hint">Everyone customers can book. ' + (cals ? 'Pick the calendar that holds each person&#39;s appointments; busy times there are never offered.' : '') + '</p>' +
      s.staff.map(function (m, i) {
        return '<div class="set-row st-row" data-i="' + i + '">' + field('Name', 'st-name-' + i, m.name) +
          (cals ? '<div class="field"><label>Google calendar</label><select class="st-cal"><option value="">Default (' + esc((cals.filter(function (c) { return c.primary; })[0] || { summary: 'primary' }).summary) + ')</option>' + cals.map(function (c) { return '<option value="' + esc(c.id) + '"' + (m.google_calendar_id === c.id ? ' selected' : '') + '>' + esc(c.summary) + '</option>'; }).join('') + '</select></div>' : '<div></div>') +
          '<button class="btn btn-sm btn-danger" data-rm-staff="' + i + '">Remove</button></div>';
      }).join('') + '<button class="btn btn-sm" id="add-staff" style="margin-top:10px">+ Add staff member</button></div>';
    h += '<div class="card"><h2>Services</h2><p class="hint">Prices in ' + esc(p.currency) + '. Leave the price empty if it is set at the appointment.</p>' +
      s.services.map(function (v, i) {
        return '<div class="set-row sv-row" data-i="' + i + '">' + field('Service', 'sv-name-' + i, v.name) + field('Minutes', 'sv-dur-' + i, v.duration_minutes, 'type="number" min="5" max="600"') +
          field('Price', 'sv-price-' + i, major(v.price), 'type="number" min="0" step="any"') + '<button class="btn btn-sm btn-danger" data-rm-svc="' + i + '">Remove</button>' +
          '<div class="sv-wide">' + field('Description', 'sv-desc-' + i, v.description) + '</div>' +
          (s.staff.length > 1 ? '<div class="sv-wide"><div class="field"><label>Who does it (none ticked = everyone)</label><div class="staff-pick">' + s.staff.map(function (m) { return '<label><input type="checkbox" class="sv-staff" value="' + esc(m.id) + '"' + (v.staff_ids.indexOf(m.id) >= 0 ? ' checked' : '') + ' />' + esc(m.name) + '</label>'; }).join('') + '</div></div></div>' : '') +
          '</div>';
      }).join('') + '<button class="btn btn-sm" id="add-svc" style="margin-top:10px">+ Add service</button></div>';
    var c = s.cancellation, r = s.booking_rules;
    h += '<div class="card"><h2>Cancellation rules</h2><p class="hint">Shown to every customer and AI assistant before they confirm.</p><div class="three-f">' +
      field('Free cancellation until (hours before)', 'c-free', c.free_until_hours_before, 'type="number" min="0" max="720" placeholder="Never free"') +
      field('Late cancellation fee (% of price)', 'c-late', c.late_fee_percent, 'type="number" min="0" max="100"') +
      field('No-show fee (% of price)', 'c-noshow', c.no_show_fee_percent, 'type="number" min="0" max="100"') + '</div></div>';
    h += '<div class="card"><h2>Booking rules</h2><div class="two-f">' +
      field('Start times every (minutes)', 'r-int', r.slot_interval_minutes, 'type="number" min="5" max="120"') +
      field('Break between appointments (minutes)', 'r-buf', r.buffer_minutes, 'type="number" min="0" max="120"') +
      field('Earliest booking (minutes from now)', 'r-lead', r.min_lead_minutes, 'type="number" min="0"') +
      field('Book up to (days ahead)', 'r-days', r.max_days_ahead, 'type="number" min="1" max="365"') + '</div></div>';
    var n = s.notifications;
    h += '<div class="card"><h2>Emails</h2>' + field('Send new-booking emails to', 'n-owner', n.owner_email, 'type="email" placeholder="' + esc(SV.account ? SV.account.email : '') + '"') +
      check('n-eowner', n.email_owner, 'Email me about new and cancelled bookings') + check('n-ecust', n.email_customers, 'Email customers a confirmation with a calendar invite') + '</div>';
    if (g) {
      h += '<div class="card"><h2>Google Calendar</h2>';
      if (!g.available) h += '<p class="hint">Google Calendar sync is not set up on this server.</p>';
      else if (g.connected) h += '<p class="hint">Connected as <b>' + esc(g.email || 'your Google account') + '</b>. Bookings appear in your calendar, and busy times there are never offered.</p><button class="btn btn-sm btn-danger" id="g-off">Disconnect</button>';
      else h += (g.error ? '<p class="err">' + esc(g.error) + '</p>' : '') + '<p class="hint">Bookings appear in your calendar, and anything already in it is never offered to customers.</p><button class="btn btn-primary" id="g-on">Connect Google Calendar</button>';
      h += '</div>';
    }
    h += '<div class="card"><h2>AI assistants</h2>' + check('s-listed', s.listed, 'List me in the OpenBooking app, so ChatGPT, Claude and other assistants can find and book me') + '</div>';
    h += '<div class="savebar"><span class="err" id="set-err"></span><button class="btn btn-primary" id="set-save">Save changes</button></div>';
    $('settings').innerHTML = h;

    $('settings').querySelectorAll('[data-copy]').forEach(function (b) {
      b.onclick = function () { var u = SV.links[Number(b.getAttribute('data-copy'))].url; (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { toast('Copied'); }, function () { prompt('Copy this link', u); }); };
    });
    document.querySelectorAll('[data-copy-text]').forEach(function (b) {
      b.onclick = function () { var u = b.getAttribute('data-copy-text'); (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { toast('Copied'); }, function () { prompt('Copy this', u); }); };
    });
    $('add-staff').onclick = function () { if (collect()) { draft.staff.push({ id: '', name: '' }); renderSettings(); } };
    $('add-svc').onclick = function () { if (collect()) { draft.services.push({ id: '', name: '', duration_minutes: 30, price: null, staff_ids: [] }); renderSettings(); } };
    $('settings').querySelectorAll('[data-rm-staff]').forEach(function (b) { b.onclick = function () { if (collect()) { var gone = draft.staff.splice(Number(b.getAttribute('data-rm-staff')), 1)[0]; draft.services.forEach(function (v) { v.staff_ids = v.staff_ids.filter(function (x) { return x !== gone.id; }); }); renderSettings(); } }; });
    $('settings').querySelectorAll('[data-rm-svc]').forEach(function (b) { b.onclick = function () { if (collect()) { draft.services.splice(Number(b.getAttribute('data-rm-svc')), 1); renderSettings(); } }; });
    if ($('g-on')) $('g-on').onclick = function () { api(g.connect_path, { method: 'POST', body: '{}' }).then(function (d) { location.href = d.url; }).catch(function (e) { toast(e.message); }); };
    if ($('resend-verify')) $('resend-verify').onclick = function (e) { e.preventDefault(); api(SV.account.resend_verification_path, { method: 'POST', body: '{}' }).then(function () { toast('Sent. Check your inbox.'); }).catch(function (x) { toast(x.message); }); };
    if ($('g-off')) $('g-off').onclick = function () { if (confirm('Disconnect Google Calendar?')) api(g.disconnect_path, { method: 'POST', body: '{}' }).then(loadSettings).catch(function (e) { toast(e.message); }); };
    $('set-save').onclick = save;
  }

  /** Read the form into draft. Returns false (and shows why) when something can't be parsed. */
  function collect() {
    var s = draft, err = '';
    function v(id) { var el = $(id); return el ? el.value.trim() : ''; }
    function num(id, fallback) { var x = v(id); return x === '' ? fallback : Number(x); }
    s.profile.name = v('s-name'); s.profile.category = v('s-cat'); s.profile.description = v('s-desc');
    s.profile.phone_number = v('s-phone'); s.profile.email = v('s-email'); s.profile.website = v('s-web');
    s.profile.currency = v('s-cur').toUpperCase(); s.profile.timezone = v('s-tz');
    s.profile.address = { street_address: v('s-street') || undefined, postal_code: v('s-zip') || undefined, address_locality: v('s-city') || undefined, address_country: v('s-country').toUpperCase() || undefined };
    DAYS.forEach(function (d) {
      var txt = v('h-' + d[0]), out = [];
      if (txt) txt.split(',').forEach(function (part) {
        var m = part.trim().match(/^(\\d{1,2}):?(\\d{2})\\s*-\\s*(\\d{1,2}):?(\\d{2})$/);
        if (!m) { err = err || d[1] + ': write the hours like 09:00-17:00'; return; }
        out.push({ open: m[1].padStart(2, '0') + ':' + m[2], close: m[3].padStart(2, '0') + ':' + m[4] });
      });
      s.opening_hours[d[0]] = out;
    });
    s.closed_dates = v('s-closed') ? v('s-closed').split(/[\\s,]+/).filter(Boolean) : [];
    var ids = [];
    s.staff.forEach(function (m, i) {
      m.name = v('st-name-' + i);
      var cal = document.querySelector('.st-row[data-i="' + i + '"] .st-cal');
      if (cal) m.google_calendar_id = cal.value || undefined;
      if (!m.id) m.id = uniqueId(m.name || 'staff', ids.concat(s.staff.map(function (x) { return x.id; })));
      ids.push(m.id);
    });
    var svcIds = [];
    s.services.forEach(function (x, i) {
      x.name = v('sv-name-' + i); x.description = v('sv-desc-' + i);
      x.duration_minutes = num('sv-dur-' + i, 30);
      var price = v('sv-price-' + i);
      x.price = price === '' ? null : Math.round(Number(price) * 100);
      var row = document.querySelector('.sv-row[data-i="' + i + '"]');
      var picks = row ? row.querySelectorAll('.sv-staff') : [];
      if (picks.length) x.staff_ids = Array.prototype.filter.call(picks, function (c) { return c.checked; }).map(function (c) { return c.value; });
      if (!x.id) x.id = uniqueId(x.name || 'service', svcIds.concat(s.services.map(function (y) { return y.id; })));
      svcIds.push(x.id);
    });
    var free = v('c-free');
    s.cancellation = { free_until_hours_before: free === '' ? null : Number(free), late_fee_percent: num('c-late', 0), no_show_fee_percent: num('c-noshow', 0) };
    s.booking_rules = { slot_interval_minutes: num('r-int', 15), buffer_minutes: num('r-buf', 0), min_lead_minutes: num('r-lead', 60), max_days_ahead: num('r-days', 60) };
    s.notifications = { owner_email: v('n-owner'), email_owner: $('n-eowner').checked, email_customers: $('n-ecust').checked };
    s.listed = $('s-listed').checked;
    $('set-err').textContent = err;
    return !err;
  }
  function save() {
    if (!collect()) return;
    $('set-save').disabled = true;
    api('/settings', { method: 'PUT', body: JSON.stringify(draft) })
      .then(function (d) {
        SV = d; draft = JSON.parse(JSON.stringify(d.settings)); renderSettings(); toast('Saved');
        catalog = { offerings: [], resources: [] };
        return api('/session').then(applySession);
      })
      .catch(function (e) { $('set-err').textContent = e.message; $('set-save').disabled = false; });
  }

  function applySession(s) {
    var v = s.venues[0];
    if (v) { tz = v.timezone; currency = v.currency || ''; $('venue-name').textContent = v.name; document.title = v.name + ' · OpenBooking Studio'; }
    $('nav-settings').classList.toggle('hidden', !s.settings);
    $('logout-wrap').classList.toggle('hidden', !token);
  }

  function start() {
    return api('/session').then(function (s) {
      applySession(s);
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      var wanted = location.hash.slice(1);
      if (VIEWS.indexOf(wanted) >= 0 && (wanted !== 'settings' || s.settings)) view = wanted;
      go(view);
      if (timer) clearInterval(timer);
      timer = setInterval(function () { if (!document.hidden && !$('drawer').classList.contains('open') && view !== 'services' && view !== 'settings') refresh(); }, 5000);
    });
  }
  start().catch(function () {});
})();
</script>
</body>
</html>`;
