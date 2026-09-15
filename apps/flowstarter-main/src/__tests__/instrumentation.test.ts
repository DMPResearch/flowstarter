/**
 * Security audit 2026-09-13 (Claude H2): the rate-limit protection posture
 * needs to be checked once, at server startup, not only logged from deep
 * inside a request handler after something has already gone wrong. This
 * proves `register()` — Next.js's server-startup hook — actually wires
 * `logProtectionPosture`/`assertRateLimitPostureOrThrow` in, is a no-op on
 * the Edge runtime (where a thrown boot error and a `process.env` read
 * would both be inappropriate), and really does reject an unconfigured
 * production boot rather than merely logging about it.
 *
 * `@/lib/sigma/warm` is mocked out rather than exercised for real: it wraps
 * an actual ONNX model load, whose cache is a one-off `fetch-model` command
 * away and not guaranteed present on every machine that runs this suite
 * (see apps/flowstarter-main/README.md). Its own real behaviour — warm
 * success sets 'ready', a missing model warns and sets 'missing', never
 * throws — is `src/lib/sigma/__tests__/warm.test.ts`'s job. This file only
 * needs to know `register()` calls it, after the rate-limit gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/sigma/warm', () => ({
  warmSigmaOrWarn: vi.fn().mockResolvedValue(undefined),
}));

const ORIGINAL_ENV = { ...process.env };

async function freshModule() {
  vi.resetModules();
  return import('../instrumentation');
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  // The mocked `@/lib/sigma/warm` module (registered once via vi.mock above)
  // keeps the same vi.fn() instance across vi.resetModules() calls — that
  // call resets the real module registry `freshModule()` re-imports from,
  // not the separate mock registry. Without this, call counts accumulate
  // across every test in this file instead of resetting per test.
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('instrumentation.register()', () => {
  it('is a no-op on the Edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge' as never;
    const { register } = await freshModule();
    await expect(register()).resolves.toBeUndefined();
  });

  it('logs the active tier and does not throw when a distributed limiter is configured', async () => {
    process.env.NEXT_RUNTIME = 'nodejs' as never;
    process.env.FLOWSTARTER_ENV = 'production' as never;
    process.env.ARCJET_KEY = 'ajkey_test';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { register } = await freshModule();
    await expect(register()).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('active rate-limit tier: arcjet')
    );
  });

  it('rejects an unconfigured production boot rather than only logging', async () => {
    process.env.NEXT_RUNTIME = 'nodejs' as never;
    process.env.FLOWSTARTER_ENV = 'production' as never;
    delete process.env.ARCJET_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { register } = await freshModule();
    await expect(register()).rejects.toThrow(/Refusing to start/);
  });

  it('does not reject a development boot with nothing configured', async () => {
    process.env.NEXT_RUNTIME = 'nodejs' as never;
    process.env.FLOWSTARTER_ENV = 'development' as never;
    delete process.env.ARCJET_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { register } = await freshModule();
    await expect(register()).resolves.toBeUndefined();
  });

  it('warms the sigma classifier after a successful rate-limit gate', async () => {
    process.env.NEXT_RUNTIME = 'nodejs' as never;
    process.env.FLOWSTARTER_ENV = 'development' as never;
    delete process.env.ARCJET_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { register } = await freshModule();
    const { warmSigmaOrWarn } = await import('@/lib/sigma/warm');
    await register();

    expect(warmSigmaOrWarn).toHaveBeenCalledTimes(1);
  });

  it('does not warm the sigma classifier when the rate-limit gate refuses to boot', async () => {
    process.env.NEXT_RUNTIME = 'nodejs' as never;
    process.env.FLOWSTARTER_ENV = 'production' as never;
    delete process.env.ARCJET_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { register } = await freshModule();
    const { warmSigmaOrWarn } = await import('@/lib/sigma/warm');
    await expect(register()).rejects.toThrow(/Refusing to start/);

    expect(warmSigmaOrWarn).not.toHaveBeenCalled();
  });
});
