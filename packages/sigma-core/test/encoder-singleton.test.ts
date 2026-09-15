/**
 * `getEncoder()`'s cross-module-graph sharing contract.
 *
 * Reproduced on staging 2026-09-15: `src/instrumentation.ts` warmed the
 * encoder at boot (`[sigma] warm: model ready`, `/api/health` agreed with
 * `sigma: "ready"`), yet the first real `/api/discovery/scope` request
 * against a genuinely new business description still abstained with
 * `encoder_timeout` sixteen minutes later — long past any cold-start race.
 * A one-off script on the box showed why: the process-wide `getEncoder()`
 * singleton lived in a plain module-level `let`, and Turbopack's production
 * build can hand a route handler's chunk its own independent copy of that
 * module's top-level state — the exact failure shape
 * `apps/flowstarter-main/src/lib/sigma/warm.ts` already documents and fixes
 * for its OWN state (`getSigmaHealth()`), via `globalThis`. `getEncoder()`
 * did not get the same treatment when it was written, so warming "the"
 * encoder at boot could warm a copy nothing else ever read from.
 *
 * A unit test cannot reproduce Turbopack's chunk splitting, but it CAN pin
 * the contract the fix depends on: the singleton lives on `globalThis`
 * (not a closure only this module's own top-level code can see), and two
 * independent calls to `getEncoder()` -- exactly what two different chunks
 * loading two different copies of this file would each make -- return the
 * identical instance.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getEncoder, resetEncoder } from '../src/encoder.js';

const GLOBAL_ENCODER_KEY = Symbol.for('flowstarter.sigma-core.encoder');

afterEach(() => {
  resetEncoder();
});

describe('getEncoder singleton', () => {
  it('returns the identical instance on every call', () => {
    const first = getEncoder();
    const second = getEncoder();
    expect(second).toBe(first);
  });

  it('lives on globalThis, not a module-private closure', () => {
    const encoder = getEncoder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = (globalThis as any)[GLOBAL_ENCODER_KEY];
    expect(stored).toBe(encoder);
  });

  it('resetEncoder clears the globalThis slot, not just a local variable', () => {
    const before = getEncoder();
    resetEncoder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any)[GLOBAL_ENCODER_KEY]).toBeUndefined();
    const after = getEncoder();
    expect(after).not.toBe(before);
  });

  it('a second, independently obtained reference sees the same warm state', async () => {
    // Simulates what warming through one module-graph copy and reading
    // through another must guarantee: whichever `getEncoder()` a caller
    // calls, warming ONE reference warms all of them, because they are the
    // same object.
    const warmedThroughOneCaller = getEncoder();
    // A cheap stand-in for `.warm()` that does not need the real model: set
    // state on the instance and confirm a second caller's reference sees it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (warmedThroughOneCaller as any).__probe = 'warmed';
    const readThroughAnotherCaller = getEncoder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((readThroughAnotherCaller as any).__probe).toBe('warmed');
  });
});
