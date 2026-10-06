/**
 * Sign-up page. Plain HTML, no build step. Creates the account, stores the session token where
 * Studio reads it, and continues to the guided setup (/setup).
 * The script avoids backticks and dollar-brace so it can live in this template literal.
 */
export function signupHtml(opts: {
  studioPath: string;
  setupPath: string;
  signupApi: string;
  loginPath: string;
}): string {
  const cfg = JSON.stringify(opts).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Get bookable by AI assistants · OpenBooking</title>
<meta name="description" content="Free. Your customers can book you through ChatGPT, Claude and Gemini. 10 minutes to set up." />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='%232747e8'/><path d='M10 16.5l4 4 8-9' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root { --bg: #f8f8f5; --card: #fff; --ink: #0b1020; --ink-2: #4a5068; --ink-3: #8a90a3; --line: rgba(11,16,32,.08); --line-2: rgba(11,16,32,.14); --royal: #2747e8; --royal-2: #1b34c4; --red: #dc2626; --grad: linear-gradient(135deg, #2747e8, #6fb6ff); }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0d14; --card: #141826; --ink: #eef0f6; --ink-2: #b4b9cc; --ink-3: #7d8399; --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.16); --royal: #5b75ff; --royal-2: #4561f5; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.5 Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 460px; margin: 0 auto; padding: 48px 16px 64px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -.02em; margin-bottom: 28px; }
  .brand i { width: 26px; height: 26px; border-radius: 8px; background: var(--grad); display: grid; place-items: center; }
  h1 { font-size: 28px; line-height: 1.15; letter-spacing: -.035em; font-weight: 500; margin: 0 0 10px; }
  p.lead { color: var(--ink-2); margin: 0 0 26px; }
  ul.points { padding: 0; margin: 0 0 28px; list-style: none; display: grid; gap: 6px; color: var(--ink-2); font-size: 14px; }
  ul.points li::before { content: '\\2713'; color: var(--royal); font-weight: 600; margin-right: 8px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
  .field { display: grid; gap: 5px; margin-bottom: 13px; }
  label { font-size: 13px; color: var(--ink-3); }
  input, select { font: inherit; color: inherit; height: 42px; border: 1px solid var(--line-2); border-radius: 11px; padding: 0 12px; background: var(--card); width: 100%; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  button { font: inherit; width: 100%; height: 44px; border: 0; border-radius: 11px; background: var(--royal); color: #fff; font-weight: 500; cursor: pointer; margin-top: 6px; }
  button:hover { background: var(--royal-2); }
  button[disabled] { opacity: .6; cursor: default; }
  .err { color: var(--red); font-size: 13.5px; min-height: 20px; margin-top: 10px; }
  .foot { text-align: center; color: var(--ink-3); font-size: 13.5px; margin-top: 18px; }
  .foot a { color: var(--royal); }
  @media (max-width: 420px) { .two { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <div class="brand"><i><svg width="13" height="13" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></i>OpenBooking</div>
  <h1>Let customers book you through ChatGPT, Claude and Gemini</h1>
  <p class="lead">Free. Ten minutes to set up. Every booking lands in one calendar with your phone and walk-in bookings.</p>
  <ul class="points">
    <li>No double bookings, and customers always confirm</li>
    <li>Your cancellation terms are shown before every booking</li>
    <li>Works with your Google Calendar</li>
  </ul>
  <form class="card" id="f" novalidate>
    <div class="field"><label for="business">Business name</label><input id="business" required maxlength="120" autocomplete="organization" placeholder="Studio Nord" /></div>
    <div class="two">
      <div class="field"><label for="category">Type of business</label><select id="category">
        <option value="hair_salon">Hair salon</option><option value="barber">Barber</option><option value="beauty">Beauty &amp; nails</option>
        <option value="physiotherapist">Physiotherapy</option><option value="therapist">Therapy &amp; counselling</option>
        <option value="personal_trainer">Personal training</option><option value="tutor">Tutoring</option><option value="other">Other</option>
      </select></div>
      <div class="field"><label for="city">City</label><input id="city" maxlength="100" autocomplete="address-level2" placeholder="Oslo" /></div>
    </div>
    <div class="field"><label for="name">Your name</label><input id="name" required maxlength="80" autocomplete="name" /></div>
    <div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="email" /></div>
    <div class="field"><label for="password">Password (at least 8 characters)</label><input id="password" type="password" required minlength="8" autocomplete="new-password" /></div>
    <button id="go" type="submit">Create my booking page</button>
    <div class="err" id="err"></div>
  </form>
  <div class="foot">Already have an account? <a id="login" href="#">Log in</a></div>
</main>
<script id="cfg" type="application/json">${cfg}</script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  function $(id) { return document.getElementById(id); }
  $('login').href = cfg.loginPath;
  // Where this sign-up came from: the website button (?from=hero), a campaign (utm_source) or a
  // referring site. Sent with the sign-up so it shows in analytics and the team's Slack message.
  function source() {
    try {
      var q = new URLSearchParams(location.search);
      var s = q.get('from') || q.get('utm_source') || q.get('ref');
      if (!s && document.referrer) {
        var r = new URL(document.referrer);
        if (r.hostname !== location.hostname) s = r.hostname.replace(/^www\\./, '');
      }
      return s ? s.slice(0, 80) : undefined;
    } catch (e) { return undefined; }
  }
  $('f').onsubmit = function (e) {
    e.preventDefault();
    $('err').textContent = '';
    if ($('password').value.length < 8) { $('err').textContent = 'Use a password of at least 8 characters.'; return; }
    $('go').disabled = true;
    var body = {
      business_name: $('business').value.trim(), category: $('category').value, city: $('city').value.trim() || undefined,
      your_name: $('name').value.trim(), email: $('email').value.trim(), password: $('password').value,
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || undefined,
      source: source()
    };
    fetch(cfg.signupApi, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || 'Sign-up failed'); return j; }); })
      .then(function (j) {
        try { sessionStorage.setItem('ob-studio-token', j.token); } catch (e) {}
        location.href = cfg.setupPath;
      })
      .catch(function (e) { $('err').textContent = e.message; $('go').disabled = false; });
  };
})();
</script>
</body>
</html>`;
}
