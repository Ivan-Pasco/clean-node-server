import { defineConfig } from 'vitest/config';

// Test tiers (see system-documents/test-strategy.md):
//   Tier 0 — Policy guard (scripts/check-test-policy.mjs). No vitest.
//   Tier 1 — Unit tests. No filesystem, no timers, no workers.
//   Tier 2 — Contract + regression. Mocked I/O, tmpdirs, SharedArrayBuffer.
//   Tier 3 — Integration (real DB / HTTP). Under tests/integration/**.
//
// Tier selection is done at the CLI level via npm scripts (see package.json:
// test:unit, test:contract, test:integration, test:run). Vitest itself just
// includes everything under tests/**/*.test.ts by default and excludes the
// integration folder unless it is explicitly requested.

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**/*.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
