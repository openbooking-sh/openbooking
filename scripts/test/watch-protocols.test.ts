import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  clean,
  evaluateActivity,
  evaluateCommit,
  evaluateReleases,
  issueTitle,
  truncateReport,
} from '../watch-protocols-lib.mjs';
import { checkSource, ghGet } from '../watch-protocols.mjs';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const source: any = {
  id: 'acme',
  protocol: 'ACME',
  repo: 'acme/spec',
  branch: 'main',
  ours: 'packages/adapter-acme',
  commit: { pin: 'aaaaaaaaaaaa', paths: ['schemas/', 'tests/vectors/', 'specification.md'] },
  releases: { feed: 'releases', pin: 'v2' },
  activity: { keywords: ['booking', 'cancel'] },
};

describe('evaluateCommit', () => {
  it('counts only files under watched paths, including the old name of a rename', () => {
    const r = evaluateCommit(source, fixture('compare-changed.json'));
    expect(r.changed).toBe(true);
    expect(r.relevant.map((f: any) => f.file)).toEqual([
      'schemas/booking.json',
      'specs/new.md',
      'tests/vectors/a.json',
    ]);
    expect(r.aheadBy).toBe(3);
    expect(r.compareUrl).toBe('https://github.com/acme/spec/compare/aaaaaaa...main');
    // Newest first, upstream text sanitised (no pings, no table breakers).
    expect(r.recent.map((c: any) => c.sha)).toEqual(['2222222', '1111111']);
    expect(r.recent[0].subject).not.toMatch(/[|`]/);
    expect(r.recent[0].subject).toContain('@​bob');
  });

  it('is unchanged when commits touch nothing we watch (no prefix confusion)', () => {
    const r = evaluateCommit(source, fixture('compare-unrelated.json'));
    expect(r.changed).toBe(false);
    expect(r.aheadBy).toBe(2);
  });

  it('flags a rewritten branch as a change', () => {
    const r = evaluateCommit(source, { status: 'diverged', ahead_by: 1, files: [], commits: [] });
    expect(r.changed).toBe(true);
    expect(r.rewritten).toBe(true);
  });

  it('is unchanged when the pin is the head', () => {
    const r = evaluateCommit(source, { status: 'identical', ahead_by: 0, files: [] });
    expect(r.changed).toBe(false);
  });
});

describe('evaluateReleases', () => {
  it('lists releases newer than the pin', () => {
    const r = evaluateReleases(source, fixture('releases.json'));
    expect(r.changed).toBe(true);
    expect(r.newer).toEqual([
      {
        tag: 'v3-rc',
        prerelease: true,
        published: '2026-10-10',
        url: 'https://github.com/acme/spec/releases/tag/v3-rc',
      },
    ]);
  });

  it('is unchanged when the pin is the newest', () => {
    const s = { ...source, releases: { feed: 'releases', pin: 'v3-rc' } };
    expect(evaluateReleases(s, fixture('releases.json')).changed).toBe(false);
  });

  it('refuses to guess when the pin is not in the feed', () => {
    const s = { ...source, releases: { feed: 'releases', pin: 'v0' } };
    expect(() => evaluateReleases(s, fixture('releases.json'))).toThrow(/not in the latest 3/);
  });

  it('reads tag feeds by name', () => {
    const s = { ...source, releases: { feed: 'tags', pin: 'v1' } };
    const r = evaluateReleases(s, [{ name: 'v2' }, { name: 'v1' }]);
    expect(r.newer.map((n: any) => n.tag)).toEqual(['v2']);
  });
});

describe('evaluateActivity', () => {
  const since = '2026-10-09T00:00:00.000Z';
  it('filters by keyword and splits opened from closed, never marking a change', () => {
    const r = evaluateActivity(source, fixture('issues.json'), since);
    expect(r.changed).toBe(false);
    expect(r.opened.map((i: any) => i.number)).toEqual([10]);
    // #9 does not match the keywords; #5 was opened before the window, closed inside it.
    expect(r.closed.map((i: any) => i.number)).toEqual([5]);
  });

  it('keeps everything when no keywords are given and tags merged PRs', () => {
    const r = evaluateActivity({ ...source, activity: {} }, fixture('issues.json'), since);
    expect(r.opened.map((i: any) => [i.number, i.pr, i.merged])).toEqual([
      [10, false, false],
      [9, true, true],
    ]);
  });
});

describe('buildReport', () => {
  const results = (cmp: string) => [
    {
      source,
      findings: [
        evaluateCommit(source, fixture(cmp)),
        evaluateReleases(source, fixture('releases.json')),
        evaluateActivity(source, fixture('issues.json'), '2026-10-09T00:00:00.000Z'),
      ],
      errors: [],
    },
    {
      source: { ...source, id: 'b', protocol: 'BETA', repo: 'b/b' },
      findings: [],
      errors: ['commits: HTTP 404'],
    },
  ];

  it('reports changes, names the protocols and surfaces failures', () => {
    const r = buildReport({
      date: '2026-10-17',
      days: 8,
      results: results('compare-changed.json'),
    });
    expect(r.changed).toBe(true);
    expect(r.protocols).toEqual(['ACME']);
    expect(r.failed).toEqual(['BETA']);
    expect(r.markdown).toContain('# Protocol watch 2026-10-17');
    expect(r.markdown).toContain('`schemas/booking.json` (modified)');
    expect(r.markdown).toContain(
      '[compare view](https://github.com/acme/spec/compare/aaaaaaa...main)',
    );
    expect(r.markdown).toContain(
      '[v3-rc](https://github.com/acme/spec/releases/tag/v3-rc) (pre-release)',
    );
    expect(r.markdown).toContain('**Could not check:** commits: HTTP 404');
    expect(r.markdown).toContain('| BETA | packages/adapter-acme | ERROR: commits: HTTP 404 |');
  });

  it('is not a change when only activity happened', () => {
    const quiet = [
      {
        source,
        findings: [
          evaluateCommit(source, fixture('compare-unrelated.json')),
          evaluateActivity(source, fixture('issues.json'), '2026-10-09T00:00:00.000Z'),
        ],
        errors: [],
      },
    ];
    const r = buildReport({ date: '2026-10-17', days: 8, results: quiet });
    expect(r.changed).toBe(false);
    expect(r.protocols).toEqual([]);
    expect(r.markdown).toContain('none in watched paths');
  });

  it('is deterministic', () => {
    const a = buildReport({ date: 'd', days: 8, results: results('compare-changed.json') });
    const b = buildReport({ date: 'd', days: 8, results: results('compare-changed.json') });
    expect(a.markdown).toBe(b.markdown);
  });
});

describe('helpers', () => {
  it('builds the issue title from protocol names and date', () => {
    expect(issueTitle('2026-10-17', ['MCP', 'UCP'])).toBe('Protocol watch: MCP, UCP (2026-10-17)');
  });

  it('truncates long reports on a line boundary', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const t = truncateReport(long, 200);
    expect(t.length).toBeLessThan(400);
    expect(t).toContain('Report truncated');
    expect(truncateReport('short', 200)).toBe('short');
  });

  it('cleans upstream text', () => {
    expect(clean('a | b\n`c` <d> @e')).toBe('a b c d @​e');
  });
});

describe('checkSource', () => {
  const sinceIso = '2026-10-09T00:00:00.000Z';
  it('keeps going when one call fails and reports the failure', async () => {
    const get = async (path: string) => {
      if (path.includes('/compare/')) throw new Error('boom');
      if (path.includes('/releases')) return fixture('releases.json');
      return fixture('issues.json');
    };
    const r = await checkSource(source, { get, sinceIso });
    expect(r.errors).toEqual(['commits: boom']);
    expect(r.findings.map((f: any) => f.kind)).toEqual(['release', 'activity']);
  });

  it('turns a pin missing from the feed into an error, not a crash', async () => {
    const get = async (path: string) => (path.includes('/releases') ? [{ tag_name: 'zzz' }] : []);
    const s = { ...source, commit: undefined, activity: undefined };
    const r = await checkSource(s, { get, sinceIso });
    expect(r.errors[0]).toMatch(/releases: pinned release "v2" is not in the latest 1/);
  });
});

describe('ghGet', () => {
  const res = (status: number, headers: Record<string, string> = {}, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it('names the reset time on a rate limit and suggests a token when unauthenticated', async () => {
    const fetchImpl = async () =>
      res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' });
    await expect(ghGet('/repos/a/b', { fetchImpl })).rejects.toThrow(/rate limit.*GITHUB_TOKEN/);
  });

  it('retries a 5xx once, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => (++calls === 1 ? res(502) : res(200, {}, { ok: true }));
    await expect(ghGet('/x', { fetchImpl, retryDelayMs: 0 })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('fails on a 404 without retrying and sends the token only when given', async () => {
    let seen: any;
    const fetchImpl = async (_url: string, init: any) => {
      seen = init.headers;
      return res(404);
    };
    await expect(ghGet('/x', { fetchImpl, token: 't0k' })).rejects.toThrow('HTTP 404');
    expect(seen.authorization).toBe('Bearer t0k');
    await expect(ghGet('/x', { fetchImpl })).rejects.toThrow('HTTP 404');
    expect(seen.authorization).toBeUndefined();
  });
});
