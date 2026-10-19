// Pure comparison and report code for scripts/watch-protocols.mjs. Nothing here touches the network
// or the clock, so it is tested with fixtures (scripts/test/watch-protocols.test.ts).

const short = (sha) => String(sha).slice(0, 7);

/** Upstream text goes into an issue body: no pings, no table breaks, no markup surprises. */
export function clean(text, max = 120) {
  const one = String(text ?? '')
    .replace(/[|`<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/@/g, '@​')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const underPath = (file, paths) =>
  paths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

/**
 * Commit pin vs the branch head, from GitHub's compare response. Only files under the watched
 * paths count as a change; other commits are noted but never open an issue.
 */
export function evaluateCommit(source, cmp) {
  const { pin, paths, baseline } = source.commit;
  const files = Array.isArray(cmp.files) ? cmp.files : [];
  const relevant = files
    .filter(
      (f) =>
        underPath(f.filename, paths) ||
        (f.previous_filename && underPath(f.previous_filename, paths)),
    )
    .map((f) => ({ file: f.filename, status: f.status }));
  const aheadBy = cmp.ahead_by ?? 0;
  // A branch that no longer contains the pin was rewritten: the diff means nothing, say so.
  const rewritten = cmp.status === 'behind' || cmp.status === 'diverged';
  // GitHub caps the file list at 300; with more, a path we watch may be missing from it.
  const truncated = files.length >= 300;
  const recent = (cmp.commits ?? [])
    .slice(-8)
    .reverse()
    .map((c) => ({
      sha: short(c.sha),
      subject: clean((c.commit?.message ?? '').split('\n')[0]),
      url: c.html_url,
    }));
  return {
    kind: 'commit',
    changed: relevant.length > 0 || rewritten,
    pin: short(pin),
    baseline: Boolean(baseline),
    status: cmp.status,
    aheadBy,
    rewritten,
    truncated,
    relevant,
    recent,
    compareUrl:
      cmp.html_url ?? `https://github.com/${source.repo}/compare/${pin}...${source.branch}`,
  };
}

/** Releases (or tags) newer than the pinned one, newest first as GitHub lists them. */
export function evaluateReleases(source, items) {
  const { pin, feed } = source.releases;
  const nameOf = (i) => (feed === 'tags' ? i.name : i.tag_name);
  const idx = items.findIndex((i) => nameOf(i) === pin);
  if (idx === -1) {
    throw new Error(
      `pinned ${feed === 'tags' ? 'tag' : 'release'} "${pin}" is not in the latest ${items.length}; check scripts/protocols.json`,
    );
  }
  const newer = items.slice(0, idx).map((i) => ({
    tag: nameOf(i),
    prerelease: Boolean(i.prerelease),
    published: i.published_at ? String(i.published_at).slice(0, 10) : null,
    url: i.html_url ?? `https://github.com/${source.repo}/releases/tag/${nameOf(i)}`,
  }));
  return { kind: 'release', changed: newer.length > 0, pin, newer };
}

/** Issues and PRs opened or closed since `sinceIso`, narrowed by title keywords when given. */
export function evaluateActivity(source, items, sinceIso, limit = 10) {
  const keywords = (source.activity?.keywords ?? []).map((k) => k.toLowerCase());
  const matches = (i) =>
    keywords.length === 0 || keywords.some((k) => String(i.title).toLowerCase().includes(k));
  const row = (i) => ({
    number: i.number,
    title: clean(i.title),
    url: i.html_url,
    pr: Boolean(i.pull_request),
    merged: Boolean(i.pull_request?.merged_at),
  });
  const kept = items.filter(matches);
  const opened = kept.filter((i) => i.created_at >= sinceIso);
  const closed = kept.filter(
    (i) => i.closed_at && i.closed_at >= sinceIso && i.created_at < sinceIso,
  );
  return {
    kind: 'activity',
    changed: false,
    opened: opened.slice(0, limit).map(row),
    closed: closed.slice(0, limit).map(row),
    openedTotal: opened.length,
    closedTotal: closed.length,
  };
}

const kindOf = (r) => (r.pr ? (r.merged ? 'PR merged' : 'PR') : 'issue');

/**
 * results: [{ source, findings: [...], errors: [string] }]
 * Returns { changed, protocols, failed, markdown }.
 */
export function buildReport({ date, days, results }) {
  const protocols = results
    .filter((r) => r.findings.some((f) => f.changed))
    .map((r) => r.source.protocol);
  const failed = results.filter((r) => r.errors.length > 0).map((r) => r.source.protocol);
  const lines = [];
  lines.push(`# Protocol watch ${date}`, '');
  lines.push(
    `What changed upstream since the pins in \`scripts/protocols.json\`. Review the diffs, fix or file follow-ups, then bump the pin and the notes in \`docs/PROTOCOLS.md\`. Issue and PR activity covers the last ${days} days and is informational only.`,
    '',
  );
  lines.push('| Protocol | Ours | Result |', '| --- | --- | --- |');
  for (const r of results) {
    const parts = [];
    for (const f of r.findings) {
      if (f.kind === 'commit') {
        parts.push(
          f.rewritten
            ? 'branch rewritten'
            : f.relevant.length
              ? `${f.relevant.length} watched file(s) changed`
              : `${f.aheadBy} commit(s), none in watched paths`,
        );
      } else if (f.kind === 'release') {
        parts.push(f.newer.length ? `${f.newer.length} new release(s)` : 'no new release');
      }
    }
    for (const e of r.errors) parts.push(`ERROR: ${clean(e, 80)}`);
    lines.push(
      `| ${r.source.protocol} | ${r.source.ours} | ${parts.join('; ') || 'nothing to check'} |`,
    );
  }
  lines.push('');

  for (const r of results) {
    const body = [];
    for (const f of r.findings) {
      if (f.kind === 'release' && f.changed) {
        body.push(`**New since \`${f.pin}\`:**`);
        for (const n of f.newer) {
          body.push(
            `- [${clean(n.tag)}](${n.url})${n.prerelease ? ' (pre-release)' : ''}${n.published ? `, ${n.published}` : ''}`,
          );
        }
        body.push('');
      }
      if (f.kind === 'commit' && f.changed) {
        body.push(
          `**Watched files changed since ${f.baseline ? 'the baseline' : 'our pin'} \`${f.pin}\`** (${f.aheadBy} commits ahead, [compare view](${f.compareUrl})):`,
        );
        if (f.rewritten) {
          body.push(
            `- The branch no longer contains the pinned commit (compare status \`${f.status}\`). The history was rewritten: re-pin by hand.`,
          );
        }
        for (const x of f.relevant.slice(0, 40)) {
          body.push(`- \`${x.file}\` (${x.status})`);
        }
        if (f.relevant.length > 40) body.push(`- … and ${f.relevant.length - 40} more`);
        if (f.truncated) {
          body.push(
            '- GitHub listed 300 files, the maximum: more may have changed. Use the compare view.',
          );
        }
        if (f.recent.length) {
          body.push('', 'Latest commits:');
          for (const c of f.recent) body.push(`- [${c.sha}](${c.url}) ${c.subject}`);
        }
        body.push('');
      }
      if (f.kind === 'activity' && (f.opened.length || f.closed.length)) {
        const list = (title, rows, total) => {
          if (!rows.length) return;
          body.push(
            `${title} (${total}${total > rows.length ? `, first ${rows.length} shown` : ''}):`,
          );
          for (const x of rows) body.push(`- [#${x.number}](${x.url}) ${x.title} (${kindOf(x)})`);
        };
        list('Opened', f.opened, f.openedTotal);
        list('Closed or merged', f.closed, f.closedTotal);
        body.push('');
      }
    }
    for (const e of r.errors) body.push(`**Could not check:** ${clean(e, 300)}`, '');
    if (body.length) lines.push(`## ${r.source.protocol} (${r.source.repo})`, '', ...body);
  }
  return {
    changed: protocols.length > 0,
    protocols,
    failed,
    markdown: `${lines.join('\n').trimEnd()}\n`,
  };
}

export function issueTitle(date, protocols) {
  return `Protocol watch: ${protocols.join(', ')} (${date})`;
}

/** Keeps an issue body under GitHub's 65536 character limit without cutting mid-line. */
export function truncateReport(markdown, max = 60000) {
  if (markdown.length <= max) return markdown;
  const cut = markdown.slice(0, max).replace(/\n[^\n]*$/, '');
  return `${cut}\n\n_Report truncated. Run \`node scripts/watch-protocols.mjs --dry-run\` for the full text._\n`;
}
