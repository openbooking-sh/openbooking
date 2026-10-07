import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// New projects depend on the @openbooking-sh packages released alongside this version. Each
// package has its own version (postgres can be ahead of server), so read every one.
const versions = Object.fromEntries(
  ['postgres', 'provider-memory', 'server'].map((name) => [
    name,
    (JSON.parse(readFileSync(`../${name}/package.json`, 'utf8')) as { version: string }).version,
  ]),
);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __OPENBOOKING_VERSIONS__: JSON.stringify(versions) },
});
