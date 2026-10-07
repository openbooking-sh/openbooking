// Daily SDK digest for the team's Slack: is anyone using OpenBooking?
//
// npm downloads per package (yesterday and the last 7 days), create-openbooking downloads as a
// proxy for new projects, GitHub stars and forks, and issues or PRs opened in the last day by
// people outside the org. Counts and public GitHub titles only.
//
// Run: SLACK_WEBHOOK_URL=… GITHUB_TOKEN=… node scripts/digest.mjs [--dry-run]
// Without SLACK_WEBHOOK_URL (or with --dry-run) it prints the message instead.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = process.env.GITHUB_REPOSITORY ?? 'openbooking-sh/openbooking';
const webhook = process.env.SLACK_WEBHOOK_URL;
const dryRun = process.argv.includes('--dry-run') || !webhook;
const since = Date.now() - 24 * 3600_000;

const packages = readdirSync(join(root, 'packages'))
  .map((dir) => join(root, 'packages', dir, 'package.json'))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((pkg) => !pkg.private)
  .map((pkg) => pkg.name);

async function json(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'openbooking-digest', ...headers } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// npm's bulk endpoint doesn't take scoped names, so one request per package and period.
async function downloads(name, period) {
  try {
    const doc = await json(`https://api.npmjs.org/downloads/point/${period}/${name}`);
    return doc.downloads ?? 0;
  } catch {
    return 0;
  }
}

const gh = (path) =>
  json(`https://api.github.com/${path}`, {
    accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  });

const rows = await Promise.all(
  packages.map(async (name) => ({
    name,
    day: await downloads(name, 'last-day'),
    week: await downloads(name, 'last-week'),
  })),
);
rows.sort((a, b) => b.week - a.week);
const scaffolds = rows.find((r) => r.name === 'create-openbooking');

const lines = [':package: *OpenBooking daily*'];
if (scaffolds) {
  lines.push(
    `New projects (create-openbooking downloads): ${scaffolds.day} yesterday, ${scaffolds.week} this week`,
  );
}
const total = rows.reduce((n, r) => ({ day: n.day + r.day, week: n.week + r.week }), {
  day: 0,
  week: 0,
});
lines.push(`npm downloads, all packages: ${total.day} yesterday, ${total.week} this week`);
const top = rows.filter((r) => r.week > 0 && r.name !== 'create-openbooking').slice(0, 5);
if (top.length) {
  lines.push(
    `Top: ${top.map((r) => `${r.name.replace('@openbooking-sh/', '')} ${r.week}`).join(', ')}`,
  );
}

try {
  const info = await gh(`repos/${repo}`);
  // The last page of stargazers holds the newest. Starred-at times need the star+json media type; count only, no usernames.
  const recent = await json(
    `https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${Math.max(1, Math.ceil(info.stargazers_count / 100))}`,
    {
      accept: 'application/vnd.github.star+json',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  )
    .then((list) => list.filter((s) => Date.parse(s.starred_at) > since).length)
    .catch(() => 0);
  lines.push(
    `GitHub: ${info.stargazers_count} stars${recent ? ` (+${recent})` : ''}, ${info.forks_count} forks, ${info.open_issues_count} open issues and PRs`,
  );

  const owner = repo.split('/')[0];
  const fresh = (
    await gh(`repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=30`)
  ).filter(
    (i) =>
      Date.parse(i.created_at) > since &&
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(i.author_association) &&
      i.user?.type !== 'Bot' &&
      i.user?.login !== owner,
  );
  for (const i of fresh.slice(0, 5)) {
    const kind = i.pull_request ? 'PR' : 'Issue';
    const title = i.title.replace(/[<>&]/g, '').slice(0, 100);
    lines.push(`:speech_balloon: New ${kind}: <${i.html_url}|${title}>`);
  }
} catch (e) {
  lines.push(`GitHub: unavailable (${e.message})`);
}

const text = lines.join('\n');
if (dryRun) {
  console.log(text);
} else {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack: ${res.status}`);
  console.log('posted');
}
