import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

/** The minimum a local-mode worker is allowed to need: no GitHub, no Pi key. */
function localEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FLOWSTARTER_BUILD_MODE: 'local',
    FLOWSTARTER_BUILD_STUB_AGENT: 'true',
    FLOWSTARTER_BUILD_WORKER_SECRET: 's'.repeat(48),
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    ...overrides,
  };
}

describe('local publish mode', () => {
  it('boots with no GitHub credentials, no model key and no provisioned host', () => {
    const config = loadConfig(localEnv());

    expect(config.publishMode).toBe('local');
    expect(config.github).toBeNull();
    expect(config.local).toMatchObject({
      artifactsRoot: '/tmp/flowstarter-build-artifacts',
      flowstarterMainUrl: 'http://127.0.0.1:3000',
      outputDir: 'dist',
      stubAgent: true,
    });
    // The artifact URL the deploy-agent will fetch defaults to this worker.
    expect(config.local?.artifactBaseUrl).toBe('http://127.0.0.1:8787');
    // Git roots are invented rather than demanded, and local-repo.ts creates
    // the repository on first boot.
    expect(config.git.repositoryRoot).toBe('/tmp/flowstarter-local/repository');
    expect(config.git.worktreesRoot).toBe('/tmp/flowstarter-local/worktrees');
  });

  it('lets the staging template be plain http, because loopback has no certificate', () => {
    expect(loadConfig(localEnv()).stagingUrlTemplate).toBe(
      'http://localhost:8788/{projectId}/',
    );
  });

  it('still demands https for the staging template in github mode', () => {
    expect(() =>
      loadConfig({
        FLOWSTARTER_BUILD_WORKER_SECRET: 's'.repeat(48),
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        PI_API_KEY: 'pi-key',
        FLOWSTARTER_REPOSITORY_ROOT: '/srv/repo',
        FLOWSTARTER_WORKTREES_ROOT: '/srv/worktrees',
        FLOWSTARTER_SITES_REPO: 'flowstarter/sites',
        FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp_token',
        FLOWSTARTER_STAGING_URL_TEMPLATE: 'http://{projectId}.example.com',
      }),
    ).toThrow(ConfigError);
  });

  it('refuses the stub agent outside local mode, so production cannot ship an unbuilt site', () => {
    const config = loadConfig({
      FLOWSTARTER_BUILD_STUB_AGENT: 'true',
      FLOWSTARTER_BUILD_WORKER_SECRET: 's'.repeat(48),
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      PI_API_KEY: 'pi-key',
      FLOWSTARTER_REPOSITORY_ROOT: '/srv/repo',
      FLOWSTARTER_WORKTREES_ROOT: '/srv/worktrees',
      FLOWSTARTER_SITES_REPO: 'flowstarter/sites',
      FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp_token',
    });
    expect(config.publishMode).toBe('github');
    expect(config.local).toBeNull();
  });

  it('still requires a model key in local mode when the stub is not selected', () => {
    expect(() =>
      loadConfig(localEnv({ FLOWSTARTER_BUILD_STUB_AGENT: undefined })),
    ).toThrow(ConfigError);
    expect(
      loadConfig(
        localEnv({ FLOWSTARTER_BUILD_STUB_AGENT: undefined, PI_API_KEY: 'k' }),
      ).local?.stubAgent,
    ).toBe(false);
  });

  it('rejects an unknown publish mode rather than silently picking one', () => {
    expect(() =>
      loadConfig(localEnv({ FLOWSTARTER_BUILD_MODE: 'dry' })),
    ).toThrow(ConfigError);
  });

  it('rejects a non-http artifact base or main URL', () => {
    expect(() =>
      loadConfig(
        localEnv({ FLOWSTARTER_BUILD_ARTIFACT_BASE_URL: 'ftp://example.com' }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(localEnv({ FLOWSTARTER_MAIN_URL: 'not a url' })),
    ).toThrow(ConfigError);
  });
});

describe('FLOWSTARTER_MAIN_URL — no silent default to port 3000', () => {
  const originalVitest = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.VITEST = originalVitest;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('fails at boot with a clear message when unset outside the test runtime', () => {
    // `localEnv()` never sets FLOWSTARTER_MAIN_URL, and this suite normally
    // benefits from Vitest's own `VITEST=true` keeping the old default alive
    // for every other test in this file. Unset both of the test-runtime
    // signals so this one case proves what a real `dev:local` boot without
    // the variable actually does.
    process.env.VITEST = undefined;
    process.env.NODE_ENV = 'development';

    expect(() => loadConfig(localEnv())).toThrow(ConfigError);
    expect(() => loadConfig(localEnv())).toThrow(/FLOWSTARTER_MAIN_URL/);
  });

  it('still defaults to port 3000 inside the unit-test runtime, so the rest of this suite is unaffected', () => {
    process.env.VITEST = 'true';

    const config = loadConfig(localEnv());

    expect(config.local?.flowstarterMainUrl).toBe('http://127.0.0.1:3000');
  });

  it('uses an explicit value in any runtime', () => {
    process.env.VITEST = undefined;
    process.env.NODE_ENV = 'development';

    const config = loadConfig(
      localEnv({ FLOWSTARTER_MAIN_URL: 'http://127.0.0.1:3067' }),
    );

    expect(config.local?.flowstarterMainUrl).toBe('http://127.0.0.1:3067');
  });
});
