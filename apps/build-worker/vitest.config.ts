import { defineConfig } from 'vitest/config';

/**
 * The bar for the worker code that moves a paid build: the job store (every
 * query here bypasses RLS and filters by hand), the validator that decides
 * whether a generated site may ship, and the HTTP entry point.
 */
const CRITICAL = {
  lines: 90,
  functions: 90,
  statements: 90,
  branches: 80,
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Nothing in this worker may reach the network, Supabase, git or Pi during
    // unit tests — every one of those is an injected seam. A short timeout
    // catches an accidental real call.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      // The global numbers are the coverage measured on 2026-09-09 rounded
      // down to the integer: a floor the suite can only rise from, raised by
      // `scripts/coverage-ratchet.mjs` and never lowered by it.
      thresholds: {
        lines: 61,
        functions: 64,
        branches: 61,
        statements: 59,

        'src/job-store.ts': CRITICAL,
        'src/validator.ts': CRITICAL,
        'src/index.ts': CRITICAL,
      },
    },
  },
});
