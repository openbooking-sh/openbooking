import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Load workspace packages from src/ (see "@openbooking/source" export condition).
    conditions: ['@openbooking/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@openbooking/source'],
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'bench/test/**/*.test.ts'],
    environment: 'node',
  },
});
