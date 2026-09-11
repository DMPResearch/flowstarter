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
