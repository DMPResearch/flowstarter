import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The toy-taxonomy test trains centroids with the REAL encoder: a cold
    // ONNX session plus a few dozen embeddings is far past the 5s default.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One ONNX session at a time. Several in parallel only thrash the CPU.
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
