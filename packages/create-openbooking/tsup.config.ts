import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// New projects depend on the @openbooking-sh packages released alongside this version.
const { version } = JSON.parse(readFileSync('../server/package.json', 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __OPENBOOKING_VERSION__: JSON.stringify(version) },
});
