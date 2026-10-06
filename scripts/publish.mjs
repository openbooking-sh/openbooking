// Publishes every public package whose current version isn't on npm yet.
//
// pnpm pack turns `workspace:^` into real version ranges; npm then uploads the tarball. In GitHub
// Actions it runs `npm stage publish` with trusted publishing (OIDC, no token) and provenance: the
// version waits on npmjs.com until a maintainer approves it with 2FA (Staged Packages). Brand-new
// packages can't be staged, so their first version is published by hand. Prints
// "New tag: name@version" lines so changesets/action creates GitHub releases, and tags each
// published version in git.
//
// Run: node scripts/publish.mjs [--dry-run] [--otp=123456]
// Locally, npm asks for a 2FA code when it needs one (or pass --otp).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const out = join(root, '.release');
const dryRun = process.argv.includes('--dry-run');
const ci = !!process.env.GITHUB_ACTIONS;
const otp = process.argv.find((a) => a.startsWith('--otp='));
const sh = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

async function published(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
  if (res.status === 404) return false;
  const doc = await res.json();
  return !!doc.versions?.[version];
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

let count = 0;
for (const dir of readdirSync(join(root, 'packages'))) {
  const pkgDir = join(root, 'packages', dir);
  const file = join(pkgDir, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (pkg.private) continue;
  if (await published(pkg.name, pkg.version)) {
    console.log(`skip ${pkg.name}@${pkg.version} (already on npm)`);
    continue;
  }
  const before = new Set(readdirSync(out));
  sh('pnpm', ['pack', '--pack-destination', out], pkgDir);
  const tarball = readdirSync(out).find((f) => !before.has(f));
  const args = [
    ...(ci ? ['stage', 'publish'] : ['publish']),
    join(out, tarball),
    '--access',
    'public',
    ...(ci ? ['--provenance'] : []),
    ...(otp ? [otp] : []),
  ];
  if (dryRun) {
    console.log(`would run: npm ${args.join(' ')}`);
    continue;
  }
  // Inherit stdio so npm can prompt for a 2FA code.
  execFileSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(
    ci
      ? `Staged ${pkg.name}@${pkg.version}: approve it on npmjs.com`
      : `Published ${pkg.name}@${pkg.version}`,
  );
  console.log(`New tag: ${pkg.name}@${pkg.version}`);
  sh('git', ['tag', `${pkg.name}@${pkg.version}`]);
  count++;
}
console.log(dryRun ? 'dry run done' : `published ${count} package(s)`);
