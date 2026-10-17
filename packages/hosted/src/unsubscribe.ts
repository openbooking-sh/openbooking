/**
 * The unsubscribe page behind the link in customer emails. It is a plain form with no script: the
 * GET only shows a button (mail scanners and link previewers open links, and must not unsubscribe
 * anyone), and the POST does it. It never shows the address, only the business that sent the mail.
 */
import { PRIVACY_URL } from './legal';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
body{margin:0;padding:24px 16px;background:#f8f8f5;color:#0b1020;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:440px;margin:48px auto;background:#fff;border:1px solid #e6e6e1;border-radius:14px;padding:24px}
h1{font-size:20px;margin:0 0 10px}p{color:#4a5068;line-height:1.5;margin:0 0 16px}
button{background:#2747e8;color:#fff;border:0;border-radius:10px;padding:11px 18px;font-size:15px;font-weight:500;cursor:pointer}
a{color:#646b80;font-size:13px}
</style></head><body><main>${body}</main></body></html>`;
}

/** What the link opens: one button, nothing happens until it is pressed. */
export function unsubscribeConfirmHtml(input: { businessName: string; action: string }): string {
  return shell(
    'Unsubscribe from emails',
    `<h1>Stop emails from ${esc(input.businessName)}?</h1>
<p>You will no longer get booking emails (confirmations, cancellations and calendar invites) from ${esc(input.businessName)} at the address this message was sent to. Your bookings are not affected.</p>
<form method="post" action="${esc(input.action)}"><button type="submit">Unsubscribe</button></form>
<p style="margin:16px 0 0"><a href="${esc(PRIVACY_URL)}">Privacy policy</a></p>`,
  );
}

export function unsubscribeDoneHtml(businessName: string): string {
  return shell(
    'Unsubscribed',
    `<h1>You are unsubscribed</h1>
<p>${esc(businessName)} will not send emails to this address any more. Your bookings are not affected: you can still view or cancel them on the booking page.</p>`,
  );
}

export function unsubscribeInvalidHtml(): string {
  return shell(
    'Link not valid',
    `<h1>This link is not valid</h1>
<p>The unsubscribe link is damaged or no longer works. Use the link in the most recent email you received, or reply to that email and ask the business to stop.</p>`,
  );
}
