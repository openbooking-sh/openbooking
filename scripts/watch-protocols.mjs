/* global AbortSignal */
// Checks every protocol we follow against the state we pinned (scripts/protocols.json) and prints
// a markdown report of what changed upstream. It only reads from GitHub; the weekly workflow
// (.github/workflows/watch-protocols.yml) is what turns the report into an issue.
//
// Usage: node scripts/watch-protocols.mjs [--dry-run] [--only <id>] [--days N] [--now ISO] [--out FILE]
//   --dry-run  print the report and touch nothing else (no file, no GITHUB_OUTPUT)
//   --out      also write the report to FILE
// Reads GITHUB_TOKEN or GH_TOKEN when set (higher rate limit); works without one.
// Exit code: 0 checked everything, 2 some source could not be checked (never hidden), 1 bad usage.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildReport,
  evaluateActivity,
  evaluateCommit,
  evaluateReleases,
  issueTitle,
  truncateReport,
} from './watch-protocols-lib.mjs';

const API = 'https://api.github.com';

export async function ghGet(path, { token, fetchImpl = fetch, retryDelayMs = 1000 } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'openbooking-protocol-watch',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw new Error(`${path}: network error (${e.message})`, { cause: e });
    }
    if (res.ok) return res.json();
    const limited =
      (res.status === 403 || res.status === 429) &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'));
    if (limited) {
      const reset = res.headers.get('x-ratelimit-reset');
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'later';
      throw new Error(
        `${path}: GitHub rate limit reached (resets ${when})${token ? '' : '; set GITHUB_TOKEN for a higher limit'}`,
      );
    }
    if (res.status >= 500 && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    throw new Error(`${path}: HTTP ${res.status}`);
  }
}

/** Fetches what each source needs and evaluates it. One failing call never stops the others. */
export async function checkSource(source, { get, sinceIso }) {
  const findings = [];
  const errors = [];
  const run = async (what, fn) => {
    try {
      findings.push(await fn());
    } catch (e) {
      errors.push(`${what}: ${e.message}`);
    }
  };
  if (source.commit) {
    await run('commits', async () => {
      const { pin } = source.commit;
      const cmp = await get(`/repos/${source.repo}/compare/${pin}...${source.branch}?per_page=100`);
      return evaluateCommit(source, cmp);
    });
  }
  if (source.releases) {
    await run('releases', async () => {
      const kind = source.releases.feed === 'tags' ? 'tags' : 'releases';
      const items = await get(`/repos/${source.repo}/${kind}?per_page=30`);
      return evaluateReleases(source, items);
    });
  }
  if (source.activity) {
    await run('issues and PRs', async () => {
      const items = await get(
        `/repos/${source.repo}/issues?state=all&sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(sinceIso)}`,
      );
      return evaluateActivity(source, items, sinceIso);
    });
  }
  return { source, findings, errors };
}

function parseArgs(argv) {
  const opts = { dryRun: false, only: null, days: 8, now: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--now') opts.now = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0)
    throw new Error('--days must be a positive number');
  if (opts.now && Number.isNaN(Date.parse(opts.now))) throw new Error('--now must be an ISO date');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(
      `${e.message}\nUsage: node scripts/watch-protocols.mjs [--dry-run] [--only <id>] [--days N] [--now ISO] [--out FILE]`,
    );
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(new URL('./protocols.json', import.meta.url), 'utf8'));
  const sources = config.sources.filter((s) => !opts.only || s.id === opts.only);
  if (sources.length === 0) {
    console.error(`no source with id "${opts.only}"`);
    process.exit(1);
  }
  const now = opts.now ? new Date(opts.now) : new Date();
  const sinceIso = new Date(now.getTime() - opts.days * 86400000).toISOString();
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const get = (path) => ghGet(path, { token });

  const results = [];
  for (const source of sources) results.push(await checkSource(source, { get, sinceIso }));

  const date = now.toISOString().slice(0, 10);
  const report = buildReport({ date, days: opts.days, results });
  const markdown = truncateReport(report.markdown);
  console.log(markdown);

  if (!opts.dryRun) {
    if (opts.out) writeFileSync(opts.out, markdown);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `changed=${report.changed}\ntitle=${issueTitle(date, report.protocols)}\nfailed=${report.failed.join(', ')}\n`,
      );
    }
  }
  if (report.failed.length) {
    console.error(`could not check: ${report.failed.join(', ')}`);
    process.exitCode = 2;
  }
}

// Importable for tests; only runs when invoked as a script.
if (process.argv[1]?.endsWith('watch-protocols.mjs')) {
  await main();
}
