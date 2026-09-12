import { describe, expect, it } from 'vitest';
import { resolveBuildCommit } from '../build-commit';

/**
 * `NodeJS.ProcessEnv` (via `@types/node`) requires `NODE_ENV`, so every
 * fixture below needs one even where the test does not care about it.
 */
function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv;
}

describe('resolveBuildCommit', () => {
  it('reports the commit when FLOWSTARTER_BUILD_COMMIT is set', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_BUILD_COMMIT: 'abc1234' }),
        () => 'should-not-be-called'
      )
    ).toBe('abc1234');
  });

  it('trims surrounding whitespace off the env value', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_BUILD_COMMIT: '  abc1234\n' }),
        () => undefined
      )
    ).toBe('abc1234');
  });

  it('treats an empty FLOWSTARTER_BUILD_COMMIT as unset', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_ENV: 'production', FLOWSTARTER_BUILD_COMMIT: '' }),
        () => 'unused'
      )
    ).toBeUndefined();
  });

  it('is absent in production when unset, rather than guessed', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_ENV: 'production' }),
        () => 'should-not-be-called'
      )
    ).toBeUndefined();
  });

  it('is absent in staging when unset too (a built image, not a checkout)', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_ENV: 'staging' }),
        () => 'should-not-be-called'
      )
    ).toBeUndefined();
  });

  it('falls back to the current HEAD outside production when git is available', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_ENV: 'development' }),
        () => 'deadbeef1234'
      )
    ).toBe('deadbeef1234');
  });

  it('falls back to "dev" outside production when git is unavailable', () => {
    expect(
      resolveBuildCommit(
        env({ FLOWSTARTER_ENV: 'development' }),
        () => undefined
      )
    ).toBe('dev');
  });

  it('falls back to the working HEAD in test too (not just development)', () => {
    expect(
      resolveBuildCommit(env({ FLOWSTARTER_ENV: 'test' }), () => 'cafef00d')
    ).toBe('cafef00d');
  });

  it('never throws with the default reader, even off a git checkout that cannot run git', () => {
    // No injected reader: exercises the real readGitHeadSync, which shells
    // out to `git rev-parse HEAD` and must swallow a failure (git missing,
    // not a checkout, PATH trimmed down in a container) rather than let it
    // reach a health route.
    expect(() =>
      resolveBuildCommit(env({ FLOWSTARTER_ENV: 'development' }))
    ).not.toThrow();
  });
});
