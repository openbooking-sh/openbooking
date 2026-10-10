/**
 * Owner account emails (password reset, email verification) and the reset page. Plain HTML, no
 * build step; the script avoids backticks and dollar-brace so it can live in a template literal.
 */
import { createHash } from 'node:crypto';
import type { EmailMessage } from '@openbooking-sh/notifications';

export const RESET_TTL_MS = 60 * 60_000;
export const VERIFY_TTL_MS = 7 * 24 * 3_600_000;

/**
 * Ties a reset link to the current password: once the password changes, older links stop
 * working, so each link is single-use without storing anything.
 */
export function passwordTag(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function email(opts: {
  to: string;
  from: string;
  subject: string;
  intro: string;
  button: string;
  url: string;
  outro: string;
}): EmailMessage {
  return {
    to: opts.to,
    from: `OpenBooking <${opts.from}>`,
    subject: opts.subject,
    text: `${opts.intro}\n\n${opts.button}: ${opts.url}\n\n${opts.outro}\n\nOpenBooking`,
    html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#0b1020;max-width:480px">
<p>${esc(opts.intro)}</p>
<p><a href="${esc(opts.url)}" style="display:inline-block;background:#2747e8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px">${esc(opts.button)}</a></p>
<p style="color:#4a5068;font-size:13px">${esc(opts.outro)}</p>
<p style="color:#646b80;font-size:13px">OpenBooking</p></div>`,
  };
}

export function resetEmail(to: string, from: string, url: string): EmailMessage {
  return email({
    to,
    from,
    subject: 'Reset your OpenBooking password',
    intro: 'Someone (hopefully you) asked to reset the password for your OpenBooking account.',
    button: 'Choose a new password',
    url,
    outro:
      "The link works once and expires in an hour. If you didn't ask for this, ignore this email; your password stays the same.",
  });
}

export function verifyEmail(to: string, from: string, url: string, business: string): EmailMessage {
  return email({
    to,
    from,
    subject: 'Confirm your email for OpenBooking',
    intro: `Welcome to OpenBooking! Confirm your email so ${business} can be found in ChatGPT, Claude and other AI assistants.`,
    button: 'Confirm my email',
    url,
    outro: "Your booking page works already. If you didn't create this account, ignore this email.",
  });
}

/** `/reset`: asks for the email, or (with `#token=` in the URL) for the new password. */
export function resetHtml(opts: {
  forgotApi: string;
  resetApi: string;
  studioPath: string;
}): string {
  const cfg = JSON.stringify(opts).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Reset password · OpenBooking</title>
<style>
  :root { --bg: #f8f8f5; --card: #fff; --ink: #0b1020; --ink-2: #4a5068; --ink-3: #646b80; --line: rgba(11,16,32,.08); --line-2: rgba(11,16,32,.14); --royal: #2747e8; --royal-2: #1b34c4; --red: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0d14; --card: #141826; --ink: #eef0f6; --ink-2: #b4b9cc; --ink-3: #7d8399; --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.16); --royal: #5b75ff; --royal-2: #4561f5; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.5 system-ui, sans-serif; }
  main { max-width: 420px; margin: 0 auto; padding: 64px 16px; }
  h1 { font-size: 24px; letter-spacing: -.03em; font-weight: 500; margin: 0 0 8px; }
  p { color: var(--ink-2); margin: 0 0 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
  label { font-size: 13px; color: var(--ink-3); display: block; margin-bottom: 5px; }
  input { font: inherit; color: inherit; height: 42px; border: 1px solid var(--line-2); border-radius: 11px; padding: 0 12px; background: var(--card); width: 100%; }
  button { font: inherit; width: 100%; height: 44px; border: 0; border-radius: 11px; background: var(--royal); color: #fff; font-weight: 500; cursor: pointer; margin-top: 14px; }
  button:hover { background: var(--royal-2); } button[disabled] { opacity: .6; }
  .msg { font-size: 13.5px; min-height: 20px; margin-top: 10px; color: var(--ink-2); } .msg.err { color: var(--red); }
  .hidden { display: none; } a { color: var(--royal); }
</style>
</head>
<body>
<main>
  <form class="card" id="ask" novalidate>
    <h1>Forgot your password?</h1>
    <p>Enter the email you signed up with and we'll send you a link to choose a new one.</p>
    <label for="email">Email</label><input id="email" type="email" autocomplete="email" required />
    <button id="ask-go" type="submit">Send reset link</button>
    <div class="msg" id="ask-msg" role="status" aria-live="polite"></div>
  </form>
  <form class="card hidden" id="set" novalidate>
    <h1>Choose a new password</h1>
    <p>At least 8 characters. You'll be logged out everywhere else.</p>
    <label for="password">New password</label><input id="password" type="password" autocomplete="new-password" minlength="8" required />
    <button id="set-go" type="submit">Save and open Studio</button>
    <div class="msg" id="set-msg" role="status" aria-live="polite"></div>
  </form>
  <p style="text-align:center;margin-top:18px;font-size:13.5px"><a id="back" href="#">Back to log in</a></p>
</main>
<script id="cfg" type="application/json">${cfg}</script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  function $(id) { return document.getElementById(id); }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || 'Something went wrong'); return j; }); });
  }
  function show(id, text, isErr) { $(id).textContent = text; $(id).className = 'msg' + (isErr ? ' err' : ''); }
  $('back').href = cfg.studioPath;
  var m = /token=([^&]+)/.exec(location.hash);
  var token = m ? decodeURIComponent(m[1]) : '';
  // Keep the token out of history and screenshots once read.
  if (token) { history.replaceState(null, '', location.pathname); $('ask').classList.add('hidden'); $('set').classList.remove('hidden'); }
  $('ask').onsubmit = function (e) {
    e.preventDefault(); $('ask-go').disabled = true;
    post(cfg.forgotApi, { email: $('email').value.trim() })
      .then(function (j) { show('ask-msg', j.message); })
      .catch(function (err) { show('ask-msg', err.message, true); $('ask-go').disabled = false; });
  };
  $('set').onsubmit = function (e) {
    e.preventDefault();
    if ($('password').value.length < 8) { show('set-msg', 'Use at least 8 characters.', true); return; }
    $('set-go').disabled = true;
    post(cfg.resetApi, { token: token, password: $('password').value })
      .then(function (j) { try { sessionStorage.setItem('ob-studio-token', j.token); } catch (x) {} location.href = cfg.studioPath; })
      .catch(function (err) { show('set-msg', err.message, true); $('set-go').disabled = false; });
  };
})();
</script>
</body>
</html>`;
}
