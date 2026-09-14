/**
 * Security audit 2026-09-13 (Claude H2): the rate-limit protection posture
 * needs to be checked once, at server startup, not only logged from deep
 * inside a request handler after something has already gone wrong. This
 * proves `register()` — Next.js's server-startup hook — actually wires
 * `logProtectionPosture`/`assertRateLimitPostureOrThrow` in, is a no-op on
 * the Edge runtime (where a thrown boot error and a `process.env` read
 * would both be inappropriate), and really does reject an unconfigured
 * production boot rather than merely logging about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function freshModule() {
  vi.resetModules();
  return import('../instrumentation');
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
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
});
