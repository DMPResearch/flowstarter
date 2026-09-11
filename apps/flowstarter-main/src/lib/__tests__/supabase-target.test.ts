import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSupabaseTargetAllowed,
  classifySupabaseHost,
  describeSupabaseTarget,
  ensureSupabaseTargetAllowed,
  resetSupabaseTargetGuardForTests,
  resolveFlowstarterEnv,
} from '../supabase-target';

const LOCAL_URL = 'http://127.0.0.1:54321';
const REMOTE_URL = 'https://avptvzherjxymmbtbbbr.supabase.co';

/**
 * `NodeJS.ProcessEnv` (via `@types/node`) requires `NODE_ENV`, so every
 * fixture below needs one even where the test does not care about it.
 */
function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv;
}

describe('resolveFlowstarterEnv', () => {
  it('uses FLOWSTARTER_ENV when it is one of the four values', () => {
    expect(resolveFlowstarterEnv(env({ FLOWSTARTER_ENV: 'development' }))).toBe(
      'development'
    );
    expect(resolveFlowstarterEnv(env({ FLOWSTARTER_ENV: 'test' }))).toBe(
      'test'
    );
    expect(resolveFlowstarterEnv(env({ FLOWSTARTER_ENV: 'staging' }))).toBe(
      'staging'
    );
    expect(resolveFlowstarterEnv(env({ FLOWSTARTER_ENV: 'production' }))).toBe(
      'production'
    );
  });

  it('ignores an invalid FLOWSTARTER_ENV and falls back to NODE_ENV', () => {
    expect(
      resolveFlowstarterEnv(
        env({ FLOWSTARTER_ENV: 'nonsense', NODE_ENV: 'production' })
      )
    ).toBe('production');
  });

  it('derives production from NODE_ENV=production', () => {
    expect(resolveFlowstarterEnv(env({ NODE_ENV: 'production' }))).toBe(
      'production'
    );
  });

  it('derives test from NODE_ENV=test', () => {
    expect(resolveFlowstarterEnv(env({ NODE_ENV: 'test' }))).toBe('test');
  });

  it('derives development from any other NODE_ENV, including unset', () => {
    expect(resolveFlowstarterEnv(env({ NODE_ENV: 'development' }))).toBe(
      'development'
    );
    expect(resolveFlowstarterEnv(env({ NODE_ENV: undefined }))).toBe(
      'development'
    );
  });
});

describe('classifySupabaseHost', () => {
  it.each([
    ['http://127.0.0.1:54321', 'local'],
    ['http://localhost:54321', 'local'],
    ['http://[::1]:54321', 'local'],
    ['http://host.docker.internal:54321', 'local'],
    ['http://supabase_kong_flowstarter:8000', 'local'],
  ] as const)('classifies %s as %s', (url, expected) => {
    expect(classifySupabaseHost(url)).toBe(expected);
  });

  it.each([
    ['https://avptvzherjxymmbtbbbr.supabase.co', 'remote'],
    ['https://xcbvlzfvynargqutgivm.supabase.co', 'remote'],
    ['https://staging.flowstarter.net', 'remote'],
  ] as const)('classifies %s as %s', (url, expected) => {
    expect(classifySupabaseHost(url)).toBe(expected);
  });

  it('treats an unparsable URL as remote', () => {
    expect(classifySupabaseHost('not-a-url')).toBe('remote');
    expect(classifySupabaseHost('')).toBe('remote');
  });
});

describe('describeSupabaseTarget', () => {
  it('reports env, target and host for a local URL', () => {
    expect(
      describeSupabaseTarget(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
        })
      )
    ).toEqual({ env: 'development', target: 'local', host: '127.0.0.1' });
  });

  it('reports env, target and host for a remote URL', () => {
    expect(
      describeSupabaseTarget(
        env({
          FLOWSTARTER_ENV: 'production',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
        })
      )
    ).toEqual({
      env: 'production',
      target: 'remote',
      host: 'avptvzherjxymmbtbbbr.supabase.co',
    });
  });

  it('returns an empty host and a remote target when the URL is unset', () => {
    expect(describeSupabaseTarget(env({ FLOWSTARTER_ENV: 'test' }))).toEqual({
      env: 'test',
      target: 'remote',
      host: '',
    });
  });
});

describe('assertSupabaseTargetAllowed', () => {
  it('throws in development against a remote project', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
        })
      )
    ).toThrow(/development/);
  });

  it('names the offending host, `supabase start`, `pnpm db:env` and the override in the message', () => {
    let message = '';
    try {
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
        })
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('avptvzherjxymmbtbbbr.supabase.co');
    expect(message).toContain('supabase start');
    expect(message).toContain('pnpm db:env');
    expect(message).toContain('FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1');
  });

  it('has no em dash in its message', () => {
    try {
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
        })
      );
      throw new Error('expected assertSupabaseTargetAllowed to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('—');
    }
  });

  it('does not throw in development against the local stack', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
        })
      )
    ).not.toThrow();
  });

  it('throws in staging against a remote project', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'staging',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
        })
      )
    ).toThrow(/staging/);
  });

  it('does not throw in staging against the local stack', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({ FLOWSTARTER_ENV: 'staging', NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL })
      )
    ).not.toThrow();
  });

  it('never throws in test, remote or not', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({ FLOWSTARTER_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL })
      )
    ).not.toThrow();
  });

  it('never throws in production, remote or not', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'production',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
        })
      )
    ).not.toThrow();
  });

  it('does not throw when FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1 overrides a remote target', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
          FLOWSTARTER_ALLOW_REMOTE_SUPABASE: '1',
        })
      )
    ).not.toThrow();
  });

  it('still throws when FLOWSTARTER_ALLOW_REMOTE_SUPABASE is set to something other than "1"', () => {
    expect(() =>
      assertSupabaseTargetAllowed(
        env({
          FLOWSTARTER_ENV: 'development',
          NEXT_PUBLIC_SUPABASE_URL: REMOTE_URL,
          FLOWSTARTER_ALLOW_REMOTE_SUPABASE: '0',
        })
      )
    ).toThrow();
  });
});

describe('ensureSupabaseTargetAllowed', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetSupabaseTargetGuardForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSupabaseTargetGuardForTests();
  });

  it('throws on every call once the first check fails (a bad target stays flagged)', () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = REMOTE_URL;
    delete process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE;

    expect(() => ensureSupabaseTargetAllowed()).toThrow();

    // Memoised: the second call reuses the cached failure rather than
    // re-reading process.env, but it still throws -- a guard that goes
    // quiet after its first warning would be worse than no guard.
    expect(() => ensureSupabaseTargetAllowed()).toThrow();
  });

  it('does not re-check once the first call has succeeded, even if the env turns bad', () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL;

    expect(() => ensureSupabaseTargetAllowed()).not.toThrow();

    // The env is now bad, but the earlier success is memoised, so the
    // factories calling this on a cached-client fast path do not pay for a
    // re-check.
    process.env.NEXT_PUBLIC_SUPABASE_URL = REMOTE_URL;
    expect(() => ensureSupabaseTargetAllowed()).not.toThrow();
  });

  it('resetSupabaseTargetGuardForTests makes it re-check', () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = REMOTE_URL;
    delete process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE;

    expect(() => ensureSupabaseTargetAllowed()).toThrow();
    resetSupabaseTargetGuardForTests();
    expect(() => ensureSupabaseTargetAllowed()).toThrow();
  });

  it('does not throw when the live env is a local target', () => {
    process.env.FLOWSTARTER_ENV = 'development';
    process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL;

    expect(() => ensureSupabaseTargetAllowed()).not.toThrow();
  });
});
