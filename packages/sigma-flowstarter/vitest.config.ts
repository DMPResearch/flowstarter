import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The eval suites run the REAL semantic tier over a few hundred prompts.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // One ONNX session at a time. Parallel sessions only thrash the CPU and
    // make the latency the suites report meaningless.
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
