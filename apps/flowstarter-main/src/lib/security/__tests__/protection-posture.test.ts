/**
 * Security audit 2026-09-13 (Claude H2): Arcjet was unconfigured in both
 * running slots and its failure mode is to allow the request; Upstash was
 * absent too, so every shared rate limiter fell back to one process's
 * private memory, with only a `console.warn` nobody was watching. This is
 * the regression suite for the fix: the active tier is named at startup,
 * and `staging`/`production` refuse to boot on the process-local-only tier
 * without an explicit opt-out.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertRateLimitPostureOrThrow,
  logProtectionPosture,
  protectionPosture,
  requiresDistributedRateLimiting,
  type ProtectionEnv,
} from '../protection-posture';

describe('protectionPosture', () => {
  it('reports process-local when neither Arcjet nor Upstash is configured', () => {
    const posture = protectionPosture({});
    expect(posture).toEqual({
      arcjetConfigured: false,
      upstashConfigured: false,
      processLocalOnly: true,
      tierLabel: 'process-local',
    });
  });

  it('reports arcjet alone', () => {
    const posture = protectionPosture({ ARCJET_KEY: 'ajkey_test' });
    expect(posture.arcjetConfigured).toBe(true);
    expect(posture.processLocalOnly).toBe(false);
    expect(posture.tierLabel).toBe('arcjet');
  });

  it('reports upstash alone, only when BOTH the url and the token are set', () => {
    expect(
      protectionPosture({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' })
        .upstashConfigured
    ).toBe(false);
    const posture = protectionPosture({
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    expect(posture.upstashConfigured).toBe(true);
    expect(posture.processLocalOnly).toBe(false);
    expect(posture.tierLabel).toBe('upstash');
  });

  it('reports both when Arcjet and Upstash are both configured', () => {
    const posture = protectionPosture({
      ARCJET_KEY: 'ajkey_test',
      UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    expect(posture.tierLabel).toBe('arcjet+upstash');
    expect(posture.processLocalOnly).toBe(false);
  });

  it('treats a blank/whitespace-only key the same as absent', () => {
    const posture = protectionPosture({ ARCJET_KEY: '   ' });
    expect(posture.arcjetConfigured).toBe(false);
    expect(posture.processLocalOnly).toBe(true);
  });
});

describe('requiresDistributedRateLimiting', () => {
  it('is false for development and test', () => {
    expect(
      requiresDistributedRateLimiting({ FLOWSTARTER_ENV: 'development' })
    ).toBe(false);
    expect(requiresDistributedRateLimiting({ NODE_ENV: 'test' })).toBe(false);
  });

  it('is true for staging and production, by FLOWSTARTER_ENV', () => {
    expect(
      requiresDistributedRateLimiting({ FLOWSTARTER_ENV: 'staging' })
    ).toBe(true);
    expect(
      requiresDistributedRateLimiting({ FLOWSTARTER_ENV: 'production' })
    ).toBe(true);
  });

  it('falls back to NODE_ENV=production when FLOWSTARTER_ENV is unset', () => {
    expect(requiresDistributedRateLimiting({ NODE_ENV: 'production' })).toBe(
      true
    );
  });
});

describe('assertRateLimitPostureOrThrow', () => {
  it('does not throw in development with nothing configured', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({ FLOWSTARTER_ENV: 'development' })
    ).not.toThrow();
  });

  it('throws in production with nothing configured and no override', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({ FLOWSTARTER_ENV: 'production' })
    ).toThrow(/Refusing to start in production/);
  });

  it('throws in staging with nothing configured and no override', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({ FLOWSTARTER_ENV: 'staging' })
    ).toThrow(/no ARCJET_KEY/);
  });

  it('does not throw in production once Arcjet is configured', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({
        FLOWSTARTER_ENV: 'production',
        ARCJET_KEY: 'ajkey_test',
      })
    ).not.toThrow();
  });

  it('does not throw in production once Upstash is configured', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({
        FLOWSTARTER_ENV: 'production',
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'token',
      })
    ).not.toThrow();
  });

  it('does not throw in production with nothing configured when explicitly overridden', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({
        FLOWSTARTER_ENV: 'production',
        FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT: '1',
      })
    ).not.toThrow();
  });

  it('still throws when the override is set to anything other than the literal "1"', () => {
    expect(() =>
      assertRateLimitPostureOrThrow({
        FLOWSTARTER_ENV: 'production',
        FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT: 'true',
      })
    ).toThrow();
  });

  it('returns the posture it computed when it does not throw', () => {
    const posture = assertRateLimitPostureOrThrow({
      FLOWSTARTER_ENV: 'production',
      ARCJET_KEY: 'ajkey_test',
    });
    expect(posture.tierLabel).toBe('arcjet');
  });
});

describe('logProtectionPosture', () => {
  it('logs the active tier and never throws', () => {
    const log = vi.fn();
    const env: ProtectionEnv = { ARCJET_KEY: 'ajkey_test' };
    const posture = logProtectionPosture(env, log);
    expect(posture.tierLabel).toBe('arcjet');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('active rate-limit tier: arcjet')
    );
  });

  it('flags process-local-only in the log line', () => {
    const log = vi.fn();
    logProtectionPosture({}, log);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('single-process memory only')
    );
  });
});
