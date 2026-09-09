import { defineConfig } from 'vitest/config';

/**
 * The bar for the pipeline code the product's money depends on: the workflow
 * state machine, the git worktree policy that decides what a generated commit
 * may look like, and the job log the operator board reads. Branches sit lower
 * than the rest because v8 counts an optional-chain arm and a default
 * parameter as branches.
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
    // The pipeline must never hit the network in unit tests — the LLM seam is
    // always injected. A short timeout catches an accidental real call.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/types.ts'],
      // The global numbers are the coverage measured on 2026-09-09 rounded
      // down to the integer: a floor the suite can only rise from, raised by
      // `scripts/coverage-ratchet.mjs` and never lowered by it.
      thresholds: {
        lines: 70,
        functions: 67,
        branches: 61,
        statements: 69,

        'src/flowstarter/workflows.ts': CRITICAL,
        'src/flowstarter/worktree.ts': CRITICAL,
        'src/flowstarter/job-log.ts': CRITICAL,
      },
    },
  },
});
