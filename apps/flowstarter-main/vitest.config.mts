import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import path from 'path';
import { readFileSync } from 'fs';

/**
 * The bar every money-or-data glob below has to clear. Branches sit lower
 * than the rest on purpose: v8 counts an optional-chain arm and a default
 * parameter as branches, so 90% there would be padding, not proof.
 */
const MONEY_AND_DATA = {
  lines: 90,
  functions: 90,
  statements: 90,
  branches: 80,
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', '.next/**', 'templates/**'],
    setupFiles: ['./test/setup.ts'],
    typecheck: {
      tsconfig: './tsconfig.test.json',
    },
    pool: 'forks',
    // `poolOptions.forks.{singleFork,isolate,execArgv}` was removed in
    // Vitest 4; these are top-level options now (`singleFork` itself was
    // dropped -- forks pool already defaults to multiple forks).
    // `isolate` is `true` (not the previous `false`) because with the
    // dependency bumps on this branch, several suites register their own
    // `vi.mock('@clerk/nextjs/server', ...)` factory per file; sharing a
    // module registry across files (isolate: false) let one file's mock
    // leak into another's and flip auth-gated assertions (e.g.
    // pipeline-api.test.ts, claim-route.test.ts) depending on run order.
    isolate: true,
    execArgv: ['--max-old-space-size=4096'],
    maxConcurrency: 20,
    fileParallelism: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json', 'json-summary'],
      // `package.json` runs vitest with `--root src`, so the default
      // `./coverage` would land in `src/coverage`, which is not where CI
      // uploads from. Pin it to the package root instead.
      reportsDirectory: path.resolve(__dirname, './coverage'),
      // These are relative to the Vitest root, and `package.json` runs
      // `vitest --root src`. They used to be written `src/**`, which from
      // that root resolved to `src/src/**` and matched nothing -- so v8 only
      // ever reported the files a test happened to import, and 414 source
      // files were invisible. The measured global was 77.6% of the loaded
      // half; across the whole tree it is 41.6%. A file nobody tests now
      // costs coverage, which is the only reason to have a floor at all.
      include: ['**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        '**/__tests__/**',
        'test/**',
        '**/*.d.ts',
        'components/template-preview/**',
        'components/editor/index.ts',
        'app/global-error.tsx',
        'app/not-found.tsx',
      ],
      // Two tiers.
      //
      // The global numbers are a floor, not a target: they are the coverage
      // measured on 2026-09-09 rounded down to the integer, so the suite can
      // only get better. `scripts/coverage-ratchet.mjs` raises them from
      // `coverage-floors.json` when a run beats them; nothing lowers them.
      //
      // The per-glob numbers are a bar. Money and tenant-data code -- the
      // pricing and checkout helpers, the hosting and deploy chain, the
      // webhook signature check, and the route handlers that read or write
      // another tenant's rows -- has to be at 90% (80% on branches, where a
      // v8 branch is often an optional-chain arm rather than a decision) or
      // the gate goes red. A glob below its bar is a signal to write the
      // test, never to lower the number.
      //
      // The keys have no `src/` prefix for the same reason `include` above
      // does not: they resolve against the Vitest root, which `--root src`
      // makes `src`. A key written `src/lib/billing/**` matches no file and
      // enforces nothing, silently.
      thresholds: {
        lines: 47,
        functions: 39,
        branches: 43,
        statements: 47,

        'lib/flowstarter/**': MONEY_AND_DATA,
        'lib/billing/**': MONEY_AND_DATA,
        'lib/hosting/**': MONEY_AND_DATA,
        'lib/webhook-verification.ts': MONEY_AND_DATA,
        'app/api/webhooks/**': MONEY_AND_DATA,
        'app/api/client/**': MONEY_AND_DATA,
        'app/api/admin/projects/**': MONEY_AND_DATA,
        'app/api/team/projects/**': MONEY_AND_DATA,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` is a guard package: outside a bundler's "browser"
      // export condition (which Vitest doesn't apply), its real module
      // unconditionally throws "This module cannot be imported from a
      // Client Component module". Alias it to a no-op at the Vite resolver
      // level so every import of it -- direct or via a dependency's own
      // internal `require('server-only')` -- resolves to the stub instead
      // of the throwing implementation, regardless of which pnpm-hoisted
      // copy would otherwise be loaded.
      'server-only': path.resolve(__dirname, './test/empty-module.ts'),
    },
    // Dedupe React to prevent "Invalid hook call" from multiple React copies
    // (happens when @flowstarter/flow-design-system pulls its own React instance)
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
});
