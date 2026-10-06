// After `pnpm build`: every package that a published dist file imports at load time must be a
// regular dependency (or a Node built-in). Optional peers may only be imported lazily
// (`await import(...)`) or as types. Catches "works in the monorepo, crashes after npm install".
// Run: node scripts/check-deps.mjs
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const builtins = new Set(builtinModules);
const pkgName = (s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);

let problems = 0;
for (const dir of readdirSync(new URL('packages', root))) {
  const pkgFile = new URL(`packages/${dir}/package.json`, root);
  const dist = new URL(`packages/${dir}/dist/index.js`, root);
  if (!existsSync(pkgFile) || !existsSync(dist)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  if (pkg.private) continue;
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const source = readFileSync(dist, 'utf8');
  // Static imports only: `import x from "y"` and `import "y"`; dynamic import() is fine.
  const imported = [...source.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gm)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
    .map(pkgName);
  for (const name of new Set(imported)) {
    if (builtins.has(name) || deps.has(name)) continue;
    console.error(`${pkg.name}: imports "${name}" at load time, but it isn't a dependency`);
    problems++;
  }
}
if (problems) process.exit(1);
console.log('dependencies ok');
