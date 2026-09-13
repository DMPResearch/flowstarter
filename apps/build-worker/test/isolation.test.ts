/**
 * The rule that decides where generated code executes.
 *
 * The defect: `native` was the default everywhere, so a client's generated
 * Astro config and its build scripts ran as the worker's own user, with the
 * worker's own filesystem — neighbouring client worktrees, `/etc/flowstarter`,
 * this worker's `.env`. Scrubbing the child environment removed the
 * credentials from the process; it did nothing about the ones on disk.
 *
 * So the mode became a rule of the environment rather than an operator
 * preference, and this is that rule under test.
 */
import { describe, expect, it } from 'vitest';
import {
  commandNeedsRegistry,
  containerNetworkFor,
  ISOLATION_ENV_KEY,
  resolveContainerUser,
  resolveIsolationMode,
  resolveValidationFencing,
  SEALED_BUILD_NETWORK,
} from '../src/isolation';

describe('resolveIsolationMode', () => {
  it("isolates by default where a client's real build runs", () => {
    for (const flowstarterEnv of ['staging', 'production']) {
      expect(resolveIsolationMode({ flowstarterEnv })).toEqual({
        ok: true,
        mode: 'docker',
        source: 'default',
      });
    }
  });

  it('leaves development and test native, where there may be no daemon', () => {
    for (const flowstarterEnv of ['development', 'test']) {
      expect(resolveIsolationMode({ flowstarterEnv })).toEqual({
        ok: true,
        mode: 'native',
        source: 'default',
      });
    }
  });

  it('refuses native in staging and production, and says why', () => {
    for (const flowstarterEnv of ['staging', 'production']) {
      const resolved = resolveIsolationMode({
        requested: 'native',
        flowstarterEnv,
      });
      expect(resolved.ok).toBe(false);
      if (resolved.ok) throw new Error('unreachable');
      expect(resolved.error).toContain(flowstarterEnv);
      expect(resolved.error).toContain('.env');
      expect(resolved.error).toContain(`${ISOLATION_ENV_KEY}=docker`);
    }
  });

  it('lets a developer opt into the container locally', () => {
    expect(
      resolveIsolationMode({
        requested: 'docker',
        flowstarterEnv: 'development',
      }),
    ).toEqual({ ok: true, mode: 'docker', source: 'explicit' });
  });

  it('still honours the name this setting shipped under', () => {
    expect(
      resolveIsolationMode({
        legacyRequested: 'docker',
        flowstarterEnv: 'development',
      }),
    ).toEqual({ ok: true, mode: 'docker', source: 'explicit' });
  });

  it('refuses two variables that disagree rather than picking one', () => {
    const resolved = resolveIsolationMode({
      requested: 'docker',
      legacyRequested: 'native',
      flowstarterEnv: 'development',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error).toContain('disagree');
  });

  it('refuses a mode that is neither', () => {
    const resolved = resolveIsolationMode({
      requested: 'sandbox',
      flowstarterEnv: 'development',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error).toContain('"native" or "docker"');
  });

  it('treats an unknown environment as one that may run native', () => {
    // `resolveWorkerFlowstarterEnv` only ever produces the four known values,
    // so this is the rule being explicit rather than a reachable case.
    expect(resolveIsolationMode({ flowstarterEnv: 'review-app' })).toEqual({
      ok: true,
      mode: 'native',
      source: 'default',
    });
  });
});

describe('commandNeedsRegistry', () => {
  it('is true for the install step and nothing else', () => {
    expect(
      commandNeedsRegistry({
        bin: 'pnpm',
        args: ['install', '--ignore-scripts', '--prefer-offline'],
      }),
    ).toBe(true);
    expect(commandNeedsRegistry({ bin: 'npm', args: ['ci'] })).toBe(true);
    expect(commandNeedsRegistry({ bin: 'pnpm', args: ['run', 'build'] })).toBe(
      false,
    );
    expect(commandNeedsRegistry({ bin: 'node', args: ['--version'] })).toBe(
      false,
    );
  });

  it('reads only the subcommand, so a script called "install" is still a build', () => {
    expect(
      commandNeedsRegistry({ bin: 'pnpm', args: ['run', 'install-fonts'] }),
    ).toBe(false);
  });

  it('is false for a bare program with no subcommand', () => {
    expect(commandNeedsRegistry({ bin: 'pnpm', args: [] })).toBe(false);
  });
});

describe('containerNetworkFor', () => {
  const networks = { installNetwork: 'bridge', buildNetwork: 'none' };

  it('gives the install step egress and the build none', () => {
    expect(
      containerNetworkFor({ bin: 'pnpm', args: ['install'] }, networks),
    ).toBe('bridge');
    expect(
      containerNetworkFor({ bin: 'pnpm', args: ['run', 'build'] }, networks),
    ).toBe('none');
  });

  it('routes the install step through a named proxy network when asked', () => {
    expect(
      containerNetworkFor(
        { bin: 'pnpm', args: ['install'] },
        { installNetwork: 'registry-proxy', buildNetwork: 'none' },
      ),
    ).toBe('registry-proxy');
  });
});

describe('resolveContainerUser', () => {
  it("runs as this worker's own user, so it can read the output back", () => {
    expect(resolveContainerUser({ uid: 501, gid: 20 })).toEqual({
      ok: true,
      user: '501:20',
    });
  });

  it('refuses to run a generated build as root', () => {
    const resolved = resolveContainerUser({ uid: 0, gid: 0 });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error).toContain('running as root');
  });

  it('lets a root worker name a non-root uid instead', () => {
    expect(
      resolveContainerUser({ uid: 0, gid: 0, configured: '1000:1000' }),
    ).toEqual({ ok: true, user: '1000:1000' });
  });

  it('refuses a configured root, which would defeat the point', () => {
    const resolved = resolveContainerUser({
      uid: 501,
      gid: 20,
      configured: '0:0',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.error).toContain('uid 0');
  });

  it('refuses anything that is not uid:gid', () => {
    for (const configured of ['node', '1000', '1000:1000:1000', '-1:0']) {
      expect(resolveContainerUser({ uid: 501, gid: 20, configured }).ok).toBe(
        false,
      );
    }
  });

  it("falls back to the image's non-root user where there is no uid to read", () => {
    expect(resolveContainerUser({ uid: null, gid: null })).toEqual({
      ok: true,
      user: '1000:1000',
    });
  });
});

/**
 * The other half of the same rule. Choosing `docker` says where generated code
 * runs; this says what it can reach once it is running, and the defaults said
 * "the internet": with no prepared image the build step inherited the install
 * step's `bridge` network, so `pnpm run build` — the site's own Astro config,
 * its integrations, its build scripts — executed with egress.
 */
describe('resolveValidationFencing', () => {
  const sealed = { pnpmBaked: true, buildNetwork: SEALED_BUILD_NETWORK };

  it('accepts a staging or production worker on the prepared image with no build egress', () => {
    for (const flowstarterEnv of ['staging', 'production']) {
      expect(
        resolveValidationFencing({ flowstarterEnv, docker: sealed }),
      ).toEqual({ ok: true });
    }
  });

  it('refuses a stock image there, naming the Dockerfile that fixes it', () => {
    const refusal = resolveValidationFencing({
      flowstarterEnv: 'production',
      docker: { pnpmBaked: false, buildNetwork: 'bridge' },
    });
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.error).toContain(
      'validation-runtime.Dockerfile',
    );
  });

  it('refuses a build step with any egress at all', () => {
    for (const buildNetwork of ['bridge', 'registry-proxy']) {
      const refusal = resolveValidationFencing({
        flowstarterEnv: 'staging',
        docker: { pnpmBaked: true, buildNetwork },
      });
      expect(refusal.ok).toBe(false);
      expect(refusal.ok === false && refusal.error).toContain(
        'FLOWSTARTER_BUILD_VALIDATE_DOCKER_BUILD_NETWORK',
      );
    }
  });

  it('refuses a staging or production worker with no container at all', () => {
    expect(
      resolveValidationFencing({ flowstarterEnv: 'production', docker: null })
        .ok,
    ).toBe(false);
  });

  it('leaves a laptop alone, where there is no client money in the build', () => {
    for (const flowstarterEnv of ['development', 'test']) {
      expect(
        resolveValidationFencing({
          flowstarterEnv,
          docker: { pnpmBaked: false, buildNetwork: 'bridge' },
        }),
      ).toEqual({ ok: true });
      expect(
        resolveValidationFencing({ flowstarterEnv, docker: null }),
      ).toEqual({ ok: true });
    }
  });
});
