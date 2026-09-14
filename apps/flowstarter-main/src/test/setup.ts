import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Node 24+ ships a native `globalThis.localStorage`. Without
// `--localstorage-file` it is a stub whose methods are missing, and vitest's
// jsdom environment leaves that own property in place instead of installing
// jsdom's Storage, so `localStorage.clear()` throws. CI runs Node 22 and
// never sees it; a newer local Node does. Install a working in-memory
// Storage whenever the ambient one is unusable.
if (
  typeof (globalThis as { localStorage?: Storage }).localStorage?.clear !==
  'function'
) {
  const store = new Map<string, string>();
  const shim: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  for (const target of [
    globalThis,
    (globalThis as { window?: object }).window,
  ]) {
    if (target) {
      Object.defineProperty(target, 'localStorage', {
        value: shim,
        writable: true,
        configurable: true,
      });
    }
  }
}

// The acceptable-use gate is stubbed in tests unless a suite asks for it.
//
// Hundreds of suites drive a route that happens to sit behind the gate while
// testing something else: a rate limit, a Stripe session, a teardown path.
// Without this they would each load `@flowstarter/sigma-flowstarter` and its
// 135 MB ONNX encoder, reach a genuine verdict on a two-word fixture, and then
// try to write a `policy_reviews` row against whatever Supabase double that
// suite happened to set up. Slow, and non-deterministic in tests that have no
// opinion about policy at all.
//
// `stub` short-circuits the adapter to a clean allow. It is refused outright
// when NODE_ENV is production (see `stubClassifierEnabled`), so this cannot
// escape the test runner.
//
// Set here rather than per file so a route added later cannot forget it. The
// suites that ARE about the policy opt out for themselves:
//   classifier.test.ts, gate-fixtures.test.ts, sigma-cascade.test.ts,
//   acceptable-use-live.test.ts
process.env.ACCEPTABLE_USE_CLASSIFIER ??= 'stub';

// Belt and braces for any suite that opts the stub out but does not want the
// encoder either: the embedding tier stays off unless explicitly enabled.
process.env.ACCEPTABLE_USE_SIGMA ??= 'false';
