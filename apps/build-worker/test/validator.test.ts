import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DockerValidationConfig } from '../src/config';
import {
  CommandSiteValidator,
  containerBuildEnv,
  dockerClientEnv,
  dockerRunArgs,
  NoopSiteValidator,
  scrubbedBuildEnv,
  SiteValidationError,
  VALIDATOR_OUTPUT_LINES,
} from '../src/validator';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function siteWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-validator-'));
  temporaryDirectories.push(root);
  await writeFile(join(root, 'package.json'), '{"name":"site"}', 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

/** Stands in for `pnpm run build`: writes the dist/ output the gate requires. */
const BUILD_OK = {
  bin: 'node',
  args: ['-e', 'require("node:fs").mkdirSync("dist",{recursive:true})'],
};

describe('NoopSiteValidator', () => {
  it('passes without a package manifest or dist output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-noop-validator-'));
    temporaryDirectories.push(root);
    const validator = new NoopSiteValidator();
    await expect(validator.validate(root, 'full')).resolves.toBeUndefined();
    await expect(validator.validate(root, 'preview')).resolves.toBeUndefined();
  });
});

describe('CommandSiteValidator', () => {
  it('passes a site that installs, builds and emits output', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [BUILD_OK],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).resolves.toBeUndefined();
  });

  it('fails the job when a build command exits non-zero', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: ['-e', 'console.error("build broke");process.exit(1)'],
        },
      ],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /build broke/,
    );
  });

  it('fails when the commands succeed but produce no output directory', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', '0'] }],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /no dist\/ output directory/,
    );
  });

  it('refuses a workspace missing its manifest or sources before running anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-validator-'));
    temporaryDirectories.push(root);
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', 'process.exit(1)'] }],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /no package manifest/,
    );
  });

  it('is not the preview gate and says so rather than silently passing', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [BUILD_OK],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'preview')).rejects.toThrow(
      SiteValidationError,
    );
  });

  it('kills a command that hangs past the build timeout', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', 'setTimeout(()=>{},60000)'] }],
      timeoutMs: 1_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(/timed out/);
  });

  it('refuses a workspace that has a manifest but no source directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-validator-'));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'package.json'), '{"name":"site"}', 'utf8');
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'node', args: ['-e', 'process.exit(1)'] }],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /no source directory/,
    );
  });

  it('fails on stdout alone when a command exits non-zero without writing to stderr', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: ['-e', 'console.log("only stdout, no stderr");process.exit(1)'],
        },
      ],
      timeoutMs: 30_000,
    });
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /only stdout, no stderr/,
    );
  });

  it('runs the build with a scrubbed environment, not the worker\'s own', async () => {
    const root = await siteWorkspace();
    const secrets = {
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-leak',
      PI_API_KEY: 'pi-leak',
      FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp_leak',
      FLOWSTARTER_BUILD_WORKER_SECRET: 'shared-secret-leak',
    };
    Object.assign(process.env, secrets);
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            // The build itself is the assertion: it fails loudly if any of the
            // worker's credentials survived into the child environment.
            'const leaked=Object.keys(process.env).filter((k)=>/LEAK/i.test(String(process.env[k])));' +
              'if(leaked.length){console.error("leaked: "+leaked.join(","));process.exit(1)}' +
              'require("node:fs").mkdirSync("dist",{recursive:true})',
          ],
        },
      ],
      timeoutMs: 30_000,
    });

    try {
      await expect(validator.validate(root, 'full')).resolves.toBeUndefined();
    } finally {
      for (const key of Object.keys(secrets)) delete process.env[key];
    }
  });

  it('reports a spawn failure (missing binary) through the message fallback, not a crash', async () => {
    const root = await siteWorkspace();
    const validator = new CommandSiteValidator({
      commands: [
        { bin: 'flowstarter-command-that-does-not-exist-anywhere', args: [] },
      ],
      timeoutMs: 30_000,
    });
    // Neither stdout nor stderr exist on a spawn failure, so tailLines() and
    // the error detail both have to fall all the way back to error.message
    // rather than throwing on `undefined`.
    await expect(validator.validate(root, 'full')).rejects.toThrow(
      SiteValidationError,
    );
  });
});

/**
 * Whatever the build printed is the most useful thing in a build log, and
 * until now it only existed in a lost child-process buffer. These prove it
 * reaches the caller on both paths, bounded, so a chatty build cannot flood
 * the record it is written to.
 */
describe('CommandSiteValidator command output', () => {
  it('forwards what a passing command printed', async () => {
    const root = await siteWorkspace();
    const output: Array<{ command: string; lines: string[] }> = [];
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'console.log("building the site");console.error("1 hint");' +
              'require("node:fs").mkdirSync("dist",{recursive:true})',
          ],
        },
      ],
      timeoutMs: 30_000,
      onOutput: (command, lines) => output.push({ command, lines }),
    });

    await validator.validate(root, 'full');

    expect(output).toHaveLength(1);
    expect(output[0]?.command).toContain('node');
    expect(output[0]?.lines).toEqual(['building the site', '1 hint']);
  });

  it('forwards what a failing command printed, before it throws', async () => {
    const root = await siteWorkspace();
    const output: string[][] = [];
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'console.log("step one");console.error("PhoneField.astro:22:1 broken");' +
              'process.exit(1)',
          ],
        },
      ],
      timeoutMs: 30_000,
      onOutput: (_command, lines) => output.push(lines),
    });

    await expect(validator.validate(root, 'full')).rejects.toThrow(
      SiteValidationError,
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toEqual(['step one', 'PhoneField.astro:22:1 broken']);
  });

  it('keeps only the last 200 lines of a chatty command', async () => {
    const root = await siteWorkspace();
    let forwarded: string[] = [];
    const validator = new CommandSiteValidator({
      commands: [
        {
          bin: 'node',
          args: [
            '-e',
            'for(let i=0;i<1000;i++)console.log("line "+i);' +
              'require("node:fs").mkdirSync("dist",{recursive:true})',
          ],
        },
      ],
      timeoutMs: 30_000,
      onOutput: (_command, lines) => (forwarded = lines),
    });

    await validator.validate(root, 'full');

    expect(forwarded).toHaveLength(VALIDATOR_OUTPUT_LINES);
    expect(forwarded[0]).toBe('line 800');
    expect(forwarded.at(-1)).toBe('line 999');
  });
});

/**
 * The worker's environment holds the service-role key, the Pi key and the
 * GitHub token; the code being built is generated. These prove the two never
 * meet, whichever isolation mode is in force.
 */
describe('build environment scrubbing', () => {
  it('keeps the toolchain variables a build needs and drops everything else', () => {
    const env = scrubbedBuildEnv({
      PATH: '/usr/bin',
      HOME: '/home/build',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PNPM_HOME: '/home/build/.pnpm',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      PI_API_KEY: 'pi',
      OPENROUTER_API_KEY: 'or',
      FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp',
      FLOWSTARTER_BUILD_WORKER_SECRET: 'shared',
      AWS_SECRET_ACCESS_KEY: 'aws',
      SOME_FUTURE_CREDENTIAL: 'not-yet-invented',
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/build',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PNPM_HOME: '/home/build/.pnpm',
      CI: '1',
      npm_config_ignore_scripts: 'true',
      ASTRO_TELEMETRY_DISABLED: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    });
  });

  it('gives the docker CLI its daemon and nothing else', () => {
    expect(
      dockerClientEnv({
        PATH: '/usr/bin',
        HOME: '/home/build',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role',
        PI_API_KEY: 'pi',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/build',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    });
  });

  it('points the container at its own HOME and caches, never the host user', () => {
    const env = containerBuildEnv({
      HOME: '/home/build',
      PATH: '/usr/bin',
      PNPM_HOME: '/home/build/.pnpm',
      HTTPS_PROXY: 'http://proxy.internal:3128',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    });

    expect(env.HOME).toBe('/tmp/build');
    expect(env.COREPACK_HOME).toBe('/tmp/build/corepack');
    expect(env.npm_config_store_dir).toBe('/tmp/build/pnpm-store');
    expect(env.HTTPS_PROXY).toBe('http://proxy.internal:3128');
    expect(env.PATH).toBeUndefined();
    expect(Object.values(env)).not.toContain('service-role');
  });
});

const DOCKER: DockerValidationConfig = {
  bin: 'docker',
  image: 'node:22-bookworm-slim',
  network: 'bridge',
  memory: '4g',
  tmpfsSize: '2g',
  pidsLimit: 1_024,
  pnpmVersion: '10.29.2',
};

/**
 * The argument vector *is* the isolation boundary, so it is asserted on flag by
 * flag rather than inferred from a passing build.
 */
describe('dockerRunArgs', () => {
  const base = {
    docker: DOCKER,
    workspaceRoot: '/srv/worktrees/client-1',
    name: 'flowstarter-validate-abc123',
    env: { CI: '1' },
    user: '1000:1000',
  };

  it('mounts only the site workspace and drops every privilege', () => {
    const args = dockerRunArgs({
      ...base,
      command: { bin: 'pnpm', args: ['run', 'build'] },
    });

    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(args).toContain('--name=flowstarter-validate-abc123');
    expect(args).toContain('--network=bridge');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--memory=4g');
    expect(args).toContain('--pids-limit=1024');
    expect(args).toContain('--workdir=/site');
    expect(args).toContain('--tmpfs=/tmp:rw,exec,mode=1777,size=2g');
    expect(args).toContain('--user=1000:1000');
    expect(args).toContain('--env=CI=1');

    // Exactly one bind, and it is the workspace. Nothing grants the container a
    // Docker socket, the host home directory or any other path.
    const mounts = args.filter((arg) => arg.startsWith('--mount='));
    expect(mounts).toEqual([
      '--mount=type=bind,source=/srv/worktrees/client-1,target=/site',
    ]);
    expect(args.filter((arg) => arg === '-v' || arg.startsWith('--volume'))).toEqual(
      [],
    );
    expect(args.some((arg) => arg.includes('docker.sock'))).toBe(false);
    expect(args.some((arg) => arg.includes('--privileged'))).toBe(false);

    // The program comes from the trusted wrapper, and the image's own
    // entrypoint is never consulted.
    expect(args).toContain('--entrypoint=corepack');
    expect(args.slice(-4)).toEqual([
      'node:22-bookworm-slim',
      'pnpm@10.29.2',
      'run',
      'build',
    ]);
  });

  it('omits --user where the platform has no uid to map', () => {
    const args = dockerRunArgs({
      ...base,
      user: null,
      command: { bin: 'pnpm', args: ['install'] },
    });
    expect(args.some((arg) => arg.startsWith('--user'))).toBe(false);
  });

  it('passes a non-pnpm program straight through when the image has it', () => {
    const args = dockerRunArgs({
      ...base,
      command: { bin: 'node', args: ['--version'] },
    });
    expect(args).toContain('--entrypoint=node');
    expect(args.slice(-2)).toEqual(['node:22-bookworm-slim', '--version']);
  });

  it('refuses a program the validation image is not trusted to run', () => {
    expect(() =>
      dockerRunArgs({ ...base, command: { bin: 'make', args: ['build'] } }),
    ).toThrow(/not available in the Docker/);
  });

  it('refuses a bind source that is relative or would split the mount spec', () => {
    expect(() =>
      dockerRunArgs({
        ...base,
        workspaceRoot: 'relative/site',
        command: { bin: 'pnpm', args: ['install'] },
      }),
    ).toThrow(SiteValidationError);
    expect(() =>
      dockerRunArgs({
        ...base,
        workspaceRoot: '/srv/sites/a,target=/var/run/docker.sock',
        command: { bin: 'pnpm', args: ['install'] },
      }),
    ).toThrow(/no ","/);
  });
});

interface FakeDocker {
  /** Absolute path to hand to the validator as `docker.bin`. */
  bin: string;
  /** The argv of the last `docker run`, one element per argument. */
  runArgs: () => Promise<string[]>;
  /** One line per `docker rm` this worker issued. */
  removals: () => Promise<string[]>;
}

/**
 * Stands in for the Docker CLI: records the argv it was handed, then behaves
 * the way the real `docker run` would in the scenario under test. Keeps these
 * tests honest about the flags and the cleanup without needing a daemon — the
 * suite may not reach anything outside its tmp directory.
 */
async function fakeDocker(runBody: string): Promise<FakeDocker> {
  const directory = await mkdtemp(join(tmpdir(), 'flowstarter-fake-docker-'));
  temporaryDirectories.push(directory);
  const argvFile = join(directory, 'run-argv');
  const removedFile = join(directory, 'removed');
  const bin = join(directory, 'docker');
  await writeFile(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "rm" ]; then',
      `  printf '%s\\n' "$*" >> ${removedFile}`,
      '  exit 0',
      'fi',
      `printf '%s\\n' "$@" > ${argvFile}`,
      runBody,
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );

  const lines = async (file: string): Promise<string[]> => {
    try {
      return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    bin,
    runArgs: () => lines(argvFile),
    removals: () => lines(removedFile),
  };
}

describe('CommandSiteValidator under Docker isolation', () => {
  it('builds the site in a container and still gates on dist/ on the host', async () => {
    const root = await siteWorkspace();
    const docker = await fakeDocker('mkdir -p dist');
    const progress: string[] = [];
    const validator = new CommandSiteValidator({
      commands: [
        { bin: 'pnpm', args: ['install', '--ignore-scripts'] },
        { bin: 'pnpm', args: ['run', 'build'] },
      ],
      timeoutMs: 30_000,
      isolation: { mode: 'docker', docker: { ...DOCKER, bin: docker.bin } },
      onProgress: (message) => progress.push(message),
    });

    await expect(validator.validate(root, 'full')).resolves.toBeUndefined();

    // The last command the fake saw is the build, wrapped by corepack.
    const args = await docker.runArgs();
    expect(args[0]).toBe('run');
    expect(args).toContain(
      `--mount=type=bind,source=${root},target=/site`,
    );
    expect(args).toContain('--entrypoint=corepack');
    expect(args.slice(-3)).toEqual(['pnpm@10.29.2', 'run', 'build']);
    // Operators reading a build log should see where it ran.
    expect(progress[0]).toContain('disposable node:22-bookworm-slim container');
    expect(progress).toContain('Running pnpm run build');
  });

  it('hands the container no credential from the worker', async () => {
    const root = await siteWorkspace();
    const docker = await fakeDocker('mkdir -p dist');
    Object.assign(process.env, {
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-leak',
      PI_API_KEY: 'pi-leak',
      FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp-leak',
    });
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'pnpm', args: ['run', 'build'] }],
      timeoutMs: 30_000,
      isolation: { mode: 'docker', docker: { ...DOCKER, bin: docker.bin } },
    });

    try {
      await validator.validate(root, 'full');
      const args = await docker.runArgs();
      expect(args.filter((arg) => arg.includes('leak'))).toEqual([]);
      expect(args.filter((arg) => arg.startsWith('--env='))).toEqual([
        '--env=HOME=/tmp/build',
        '--env=XDG_CACHE_HOME=/tmp/build/cache',
        '--env=COREPACK_HOME=/tmp/build/corepack',
        '--env=COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        '--env=npm_config_cache=/tmp/build/npm',
        '--env=npm_config_store_dir=/tmp/build/pnpm-store',
        '--env=CI=1',
        '--env=npm_config_ignore_scripts=true',
        '--env=ASTRO_TELEMETRY_DISABLED=1',
        '--env=NEXT_TELEMETRY_DISABLED=1',
      ]);
    } finally {
      for (const key of [
        'SUPABASE_SERVICE_ROLE_KEY',
        'PI_API_KEY',
        'FLOWSTARTER_SITES_GITHUB_TOKEN',
      ]) {
        delete process.env[key];
      }
    }
  });

  it('force-removes the container when a build outlives the timeout', async () => {
    const root = await siteWorkspace();
    // `docker run` forwards signals, but a killed client leaves the daemon
    // holding a live container -- the case `--rm` cannot cover.
    const docker = await fakeDocker('sleep 5');
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'pnpm', args: ['run', 'build'] }],
      timeoutMs: 750,
      isolation: { mode: 'docker', docker: { ...DOCKER, bin: docker.bin } },
    });

    await expect(validator.validate(root, 'full')).rejects.toThrow(/timed out/);

    const args = await docker.runArgs();
    const name = args
      .find((arg) => arg.startsWith('--name='))
      ?.slice('--name='.length);
    expect(name).toMatch(/^flowstarter-validate-[0-9a-f]{12}$/);
    expect(await docker.removals()).toEqual([`rm --force --volumes ${name}`]);
  });

  it('reports what the failed container printed, then cleans up', async () => {
    const root = await siteWorkspace();
    const docker = await fakeDocker(
      'echo "src/pages/index.astro:3:1 Cannot find module" >&2; exit 1',
    );
    const output: string[][] = [];
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'pnpm', args: ['run', 'build'] }],
      timeoutMs: 30_000,
      isolation: { mode: 'docker', docker: { ...DOCKER, bin: docker.bin } },
      onOutput: (_command, lines) => output.push(lines),
    });

    await expect(validator.validate(root, 'full')).rejects.toThrow(
      /Cannot find module/,
    );
    // The label stays the operator's command, not the docker invocation.
    expect(output).toEqual([['src/pages/index.astro:3:1 Cannot find module']]);
    expect(await docker.removals()).toHaveLength(1);
  });

  it('never spawns docker for a command the image cannot run', async () => {
    const root = await siteWorkspace();
    const docker = await fakeDocker('mkdir -p dist');
    const validator = new CommandSiteValidator({
      commands: [{ bin: 'make', args: ['build'] }],
      timeoutMs: 30_000,
      isolation: { mode: 'docker', docker: { ...DOCKER, bin: docker.bin } },
    });

    await expect(validator.validate(root, 'full')).rejects.toThrow(
      SiteValidationError,
    );
    expect(await docker.runArgs()).toEqual([]);
  });
});
