import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FLOWSTARTER_BUILD_WORKER_SECRET: 's'.repeat(48),
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    PI_API_KEY: 'pi-key',
    FLOWSTARTER_REPOSITORY_ROOT: '/srv/flowstarter/sites',
    FLOWSTARTER_WORKTREES_ROOT: '/srv/flowstarter/worktrees',
    FLOWSTARTER_SITES_REPO: 'flowstarter/sites',
    FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp_token',
    ...overrides,
  };
}

describe('worker configuration', () => {
  it('boots with the documented minimum and sensible defaults', () => {
    const config = loadConfig(validEnv());
    expect(config.port).toBe(8787);
    expect(config.concurrency).toBe(1);
    expect(config.pi.provider).toBe('openrouter');
    expect(config.github).toMatchObject({
      owner: 'flowstarter',
      repo: 'sites',
    });
    expect(config.validateCommands.map((c) => c.bin)).toEqual(['pnpm', 'pnpm']);
    expect(config.stagingUrlTemplate).toContain('{projectId}');
  });

  it('accepts OPENROUTER_API_KEY in place of PI_API_KEY', () => {
    const config = loadConfig(
      validEnv({ PI_API_KEY: undefined, OPENROUTER_API_KEY: 'or-key' }),
    );
    expect(config.pi.apiKey).toBe('or-key');
  });

  it('refuses a shared secret short enough to brute force', () => {
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_BUILD_WORKER_SECRET: 'short' })),
    ).toThrow(ConfigError);
  });

  it('refuses to start without model credentials', () => {
    expect(() =>
      loadConfig(
        validEnv({ PI_API_KEY: undefined, OPENROUTER_API_KEY: undefined }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses relative git roots', () => {
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_WORKTREES_ROOT: 'worktrees' })),
    ).toThrow(ConfigError);
  });

  it('defaults the staging URL template to flowstarter.dev outside production', () => {
    expect(
      loadConfig(validEnv({ FLOWSTARTER_ENV: 'development' }))
        .stagingUrlTemplate,
    ).toBe('https://{projectId}.staging.flowstarter.dev');
    expect(
      loadConfig(validEnv({ FLOWSTARTER_ENV: 'staging' })).stagingUrlTemplate,
    ).toBe('https://{projectId}.staging.flowstarter.dev');
    expect(
      loadConfig(validEnv({ FLOWSTARTER_ENV: 'test' })).stagingUrlTemplate,
    ).toBe('https://{projectId}.staging.flowstarter.dev');
  });

  it('defaults the staging URL template to flowstarter.net in production', () => {
    expect(
      loadConfig(validEnv({ FLOWSTARTER_ENV: 'production' }))
        .stagingUrlTemplate,
    ).toBe('https://{projectId}.staging.flowstarter.net');
  });

  it('falls back to NODE_ENV for the staging URL template when FLOWSTARTER_ENV is unset', () => {
    expect(
      loadConfig(validEnv({ NODE_ENV: 'production' })).stagingUrlTemplate,
    ).toBe('https://{projectId}.staging.flowstarter.net');
  });

  it('an explicit FLOWSTARTER_STAGING_URL_TEMPLATE always wins', () => {
    expect(
      loadConfig(
        validEnv({
          FLOWSTARTER_ENV: 'production',
          FLOWSTARTER_STAGING_URL_TEMPLATE:
            'https://{projectId}.staging.example.com',
        }),
      ).stagingUrlTemplate,
    ).toBe('https://{projectId}.staging.example.com');
  });

  it('refuses a staging template that cannot address the project or is not https', () => {
    expect(() =>
      loadConfig(
        validEnv({
          FLOWSTARTER_STAGING_URL_TEMPLATE: 'https://staging.example.com',
        }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        validEnv({
          FLOWSTARTER_STAGING_URL_TEMPLATE: 'http://{projectId}.example.com',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses a repository that is not owner/repo', () => {
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_SITES_REPO: 'sites' })),
    ).toThrow(ConfigError);
  });

  it('parses operator-supplied validate commands', () => {
    const config = loadConfig(
      validEnv({
        FLOWSTARTER_BUILD_VALIDATE_COMMANDS: JSON.stringify([
          ['npm', 'ci'],
          ['npm', 'run', 'build'],
        ]),
      }),
    );
    expect(config.validateCommands).toEqual([
      { bin: 'npm', args: ['ci'] },
      { bin: 'npm', args: ['run', 'build'] },
    ]);
  });

  it('refuses a validate command that is a path rather than an executable name', () => {
    expect(() =>
      loadConfig(
        validEnv({
          FLOWSTARTER_BUILD_VALIDATE_COMMANDS: JSON.stringify([
            ['../../bin/sh', '-c'],
          ]),
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses malformed validate command JSON', () => {
    expect(() =>
      loadConfig(
        validEnv({ FLOWSTARTER_BUILD_VALIDATE_COMMANDS: 'pnpm build' }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_BUILD_VALIDATE_COMMANDS: '[]' })),
    ).toThrow(ConfigError);
  });

  it('validates natively unless Docker isolation is explicitly asked for', () => {
    const config = loadConfig(validEnv());
    expect(config.validateIsolation).toBe('native');
    expect(config.validateDocker).toBeNull();
  });

  it('refuses an isolation mode it does not implement', () => {
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'vm' })),
    ).toThrow(ConfigError);
  });

  it('describes Docker isolation with a pinned image and pnpm, and bounded resources', () => {
    const config = loadConfig(
      validEnv({ FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker' }),
    );
    expect(config.validateIsolation).toBe('docker');
    expect(config.validateDocker).toEqual({
      bin: 'docker',
      image: 'node:22-bookworm-slim',
      // The install step may reach a registry. On the stock image so does
      // every other command, because corepack has to fetch the pinned pnpm;
      // the shipped validation image is what turns this into 'none'.
      network: 'bridge',
      buildNetwork: 'bridge',
      pnpmBaked: false,
      memory: '4g',
      tmpfsSize: '2g',
      pidsLimit: 1_024,
      pnpmVersion: '10.29.2',
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    });
  });

  it('accepts an operator-pinned image, network, size and pnpm version', () => {
    const config = loadConfig(
      validEnv({
        FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker',
        FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE:
          'node@sha256:' + 'a'.repeat(64),
        FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK: 'none',
        FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED: 'true',
        FLOWSTARTER_BUILD_VALIDATE_DOCKER_MEMORY: '8g',
        FLOWSTARTER_BUILD_VALIDATE_DOCKER_TMPFS_SIZE: '512m',
        FLOWSTARTER_BUILD_VALIDATE_DOCKER_PIDS_LIMIT: '256',
        FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION: '10.30.0',
      }),
    );
    expect(config.validateDocker).toMatchObject({
      image: `node@sha256:${'a'.repeat(64)}`,
      network: 'none',
      memory: '8g',
      tmpfsSize: '512m',
      pidsLimit: 256,
      pnpmVersion: '10.30.0',
    });
  });

  it('refuses a validate command the Docker image cannot run', () => {
    const env = {
      FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker',
      FLOWSTARTER_BUILD_VALIDATE_COMMANDS: JSON.stringify([['make', 'build']]),
    };
    // Native mode has always allowed whatever the operator installed on the
    // host; only the container promises a fixed toolchain, so only it refuses.
    const native = loadConfig(
      validEnv({ ...env, FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'native' }),
    );
    expect(native.validateCommands).toEqual([{ bin: 'make', args: ['build'] }]);
    expect(() => loadConfig(validEnv(env))).toThrow(
      /not available in the Docker/,
    );
  });

  it('refuses Docker settings that would be read as flags or shell text', () => {
    const docker = { FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker' };
    expect(() =>
      loadConfig(
        validEnv({
          ...docker,
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE: '--privileged',
        }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        validEnv({
          ...docker,
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE: 'node:22; rm -rf /',
        }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        validEnv({
          ...docker,
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_BIN: '/usr/local/bin/docker',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses a host network, an unbounded size and a floating pnpm version', () => {
    const docker = { FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker' };
    expect(() =>
      loadConfig(
        validEnv({
          ...docker,
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK: 'host',
        }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        validEnv({
          ...docker,
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_MEMORY: 'lots',
        }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        validEnv({
          ...docker,
          FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION: 'latest',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses an out-of-range concurrency', () => {
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_BUILD_CONCURRENCY: '0' })),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_BUILD_CONCURRENCY: '99' })),
    ).toThrow(ConfigError);
  });
});

describe('skipValidation: the only switch allowed to swap in the noop validator', () => {
  it('defaults to false, so a build is validated for real unless told otherwise', () => {
    expect(loadConfig(validEnv()).skipValidation).toBe(false);
  });

  it('is independent of the stub agent -- the stub replaces only the Pi session', () => {
    // `FLOWSTARTER_BUILD_STUB_AGENT` alone (local mode's dev:local shape)
    // must never flip `skipValidation`: that coupling is exactly the bug
    // that let a SITE_REBUILD ship a raw, unbuilt Astro source tree.
    const config = loadConfig(
      validEnv({
        FLOWSTARTER_BUILD_MODE: 'local',
        FLOWSTARTER_BUILD_STUB_AGENT: 'true',
        PI_API_KEY: undefined,
        FLOWSTARTER_REPOSITORY_ROOT: undefined,
        FLOWSTARTER_WORKTREES_ROOT: undefined,
        FLOWSTARTER_SITES_REPO: undefined,
        FLOWSTARTER_SITES_GITHUB_TOKEN: undefined,
      }),
    );
    expect(config.local?.stubAgent).toBe(true);
    expect(config.skipValidation).toBe(false);
  });

  it('turns on only when FLOWSTARTER_BUILD_SKIP_VALIDATION is explicitly "true"', () => {
    expect(
      loadConfig(validEnv({ FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true' }))
        .skipValidation,
    ).toBe(true);
    expect(
      loadConfig(validEnv({ FLOWSTARTER_BUILD_SKIP_VALIDATION: '1' }))
        .skipValidation,
    ).toBe(false);
    expect(
      loadConfig(validEnv({ FLOWSTARTER_BUILD_SKIP_VALIDATION: 'yes' }))
        .skipValidation,
    ).toBe(false);
  });

  it('is allowed with no FLOWSTARTER_ENV set, which resolves to development', () => {
    expect(
      loadConfig(
        validEnv({
          FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true',
          FLOWSTARTER_ENV: undefined,
          NODE_ENV: undefined,
        }),
      ).skipValidation,
    ).toBe(true);
  });

  it("is allowed in test, the environment this worker's own suite runs as", () => {
    expect(
      loadConfig(
        validEnv({
          FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true',
          FLOWSTARTER_ENV: 'test',
        }),
      ).skipValidation,
    ).toBe(true);
  });

  it('refuses to boot when asked for on a staging host', () => {
    expect(() =>
      loadConfig(
        validEnv({
          FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true',
          FLOWSTARTER_ENV: 'staging',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('refuses to boot when asked for on a production host', () => {
    expect(() =>
      loadConfig(
        validEnv({
          FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true',
          FLOWSTARTER_ENV: 'production',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('falls back to NODE_ENV=production when FLOWSTARTER_ENV is unset', () => {
    expect(() =>
      loadConfig(
        validEnv({
          FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true',
          FLOWSTARTER_ENV: undefined,
          NODE_ENV: 'production',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('never throws for staging/production when the flag itself is not set', () => {
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_ENV: 'production' })),
    ).not.toThrow();
    expect(() =>
      loadConfig(validEnv({ FLOWSTARTER_ENV: 'staging' })),
    ).not.toThrow();
  });
});

/**
 * The two rules `loadConfig` enforces that a client's money depends on:
 * where generated code may execute, and how long a claim on their build is
 * good for.
 */
describe('isolation and leases at boot', () => {
  /**
   * A minimum viable environment. Deliberately not `validEnv()` from above:
   * these cases are about `FLOWSTARTER_ENV`, and the helper pins it.
   */
  function envFor(
    overrides: Record<string, string | undefined> = {},
  ): NodeJS.ProcessEnv {
    return {
      FLOWSTARTER_BUILD_WORKER_SECRET: 'x'.repeat(40),
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      PI_API_KEY: 'pi-key',
      FLOWSTARTER_REPOSITORY_ROOT: '/srv/sites',
      FLOWSTARTER_WORKTREES_ROOT: '/srv/worktrees',
      FLOWSTARTER_SITES_REPO: 'DMPResearch/flowstarter-sites',
      FLOWSTARTER_SITES_GITHUB_TOKEN: 'gh-token',
      FLOWSTARTER_STAGING_URL_TEMPLATE: 'https://{projectId}.staging.example',
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  it('isolates a staging or production worker without being asked', () => {
    for (const FLOWSTARTER_ENV of ['staging', 'production']) {
      const config = loadConfig(
        envFor({
          FLOWSTARTER_ENV,
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED: 'true',
        }),
      );
      expect(config.validateIsolation).toBe('docker');
      expect(config.validateDocker).not.toBeNull();
    }
  });

  it('refuses to boot a staging or production worker in native mode', () => {
    for (const FLOWSTARTER_ENV of ['staging', 'production']) {
      expect(() =>
        loadConfig(
          envFor({ FLOWSTARTER_ENV, FLOWSTARTER_BUILD_ISOLATION: 'native' }),
        ),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig(
          envFor({ FLOWSTARTER_ENV, FLOWSTARTER_BUILD_ISOLATION: 'native' }),
        ),
      ).toThrow(
        /refused when the resolved environment is staging or production/,
      );
    }
  });

  it('leaves a development worker native, where there may be no daemon', () => {
    expect(
      loadConfig(envFor({ FLOWSTARTER_ENV: 'development' })).validateIsolation,
    ).toBe('native');
    expect(
      loadConfig(envFor({ FLOWSTARTER_ENV: 'development' })).validateDocker,
    ).toBeNull();
  });

  it('still honours the name the setting shipped under', () => {
    expect(
      loadConfig(
        envFor({
          FLOWSTARTER_ENV: 'development',
          FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED: 'true',
        }),
      ).validateIsolation,
    ).toBe('docker');
  });

  it('refuses a build step with no network when the image has no toolchain', () => {
    // corepack would have to download the pinned pnpm, into a corepack home on
    // a tmpfs that dies with the container. Failing at boot beats failing
    // inside somebody's paid build.
    expect(() =>
      loadConfig(
        envFor({
          FLOWSTARTER_ENV: 'staging',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_BUILD_NETWORK: 'none',
        }),
      ),
    ).toThrow(/validation-runtime.Dockerfile/);
  });

  it('gives the build step egress only when the image cannot supply pnpm', () => {
    // Stock image: the note, made into behaviour. Egress, because every
    // command needs corepack to reach a registry.
    expect(
      loadConfig(envFor({ FLOWSTARTER_ENV: 'staging' })).validateDocker,
    ).toMatchObject({ network: 'bridge', buildNetwork: 'bridge' });
    // Shipped image: no network for anything but the install.
    expect(
      loadConfig(
        envFor({
          FLOWSTARTER_ENV: 'staging',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED: 'true',
        }),
      ).validateDocker,
    ).toMatchObject({ network: 'bridge', buildNetwork: 'none' });
  });

  it('refuses host networking, which would hand the build every local service', () => {
    expect(() =>
      loadConfig(
        envFor({
          FLOWSTARTER_ENV: 'staging',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK: 'host',
        }),
      ),
    ).toThrow(/may not be "host"/);
  });

  it('routes the install step through a named proxy network when asked', () => {
    expect(
      loadConfig(
        envFor({
          FLOWSTARTER_ENV: 'staging',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK: 'registry-proxy',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_PNPM_BAKED: 'true',
        }),
      ).validateDocker,
    ).toMatchObject({ network: 'registry-proxy', buildNetwork: 'none' });
  });

  it('defaults the lease to two minutes with a beat that fits twice inside it', () => {
    expect(loadConfig(envFor()).lease).toEqual({
      ttlMs: 120_000,
      heartbeatMs: 30_000,
      backoffBaseMs: 30_000,
      backoffMaxMs: 900_000,
    });
    // The sweep that acts on those leases is the reconciler's own interval,
    // not a second one: one loop asks the ledger what is runnable and what
    // nobody is running any more.
    expect(loadConfig(envFor()).pollIntervalMs).toBe(60_000);
  });

  it('refuses a heartbeat that cannot keep a lease alive', () => {
    // A build would lose its lease mid-run, another worker would take it, and
    // two processes would write the same worktree.
    expect(() =>
      loadConfig(
        envFor({
          FLOWSTARTER_BUILD_LEASE_TTL_MS: '60000',
          FLOWSTARTER_BUILD_LEASE_HEARTBEAT_MS: '45000',
        }),
      ),
    ).toThrow(/at most half of/);
  });

  it('refuses a backoff cap below the backoff itself', () => {
    expect(() =>
      loadConfig(
        envFor({
          FLOWSTARTER_BUILD_RETRY_BACKOFF_MS: '60000',
          FLOWSTARTER_BUILD_RETRY_BACKOFF_MAX_MS: '30000',
        }),
      ),
    ).toThrow(ConfigError);
  });
});
