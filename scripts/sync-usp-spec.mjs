// Vendors the USP schemas, OpenAPI/OpenRPC documents and test vectors into test/fixtures so the
// adapter is validated offline against the exact spec revision it targets.
// Usage: node scripts/sync-usp-spec.mjs <path to a wix/universal-scheduling-protocol checkout>
// then bump USP_SPEC_COMMIT in src/constants.ts and the commit in NOTICE.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/sync-usp-spec.mjs <spec checkout>');
  process.exit(1);
}
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const dest = new URL(
  '../packages/adapter-usp/test/fixtures/usp-spec/',
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, '$1');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const dir of ['schemas', 'openapi', 'openrpc', 'tests/vectors']) {
  cpSync(join(source, dir), join(dest, dir), { recursive: true });
}
cpSync(join(source, 'LICENSE'), join(dest, 'LICENSE'));
writeFileSync(
  join(dest, 'NOTICE'),
  `Schemas, OpenAPI/OpenRPC documents and test vectors from\nhttps://github.com/wix/universal-scheduling-protocol at ${commit}\n(Apache License 2.0, see LICENSE). Vendored unmodified for conformance tests; regenerate with\n"node scripts/sync-usp-spec.mjs <checkout>".\n`,
);
console.log(
  `vendored ${commit.slice(0, 7)}`,
  JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name ?? '',
);
