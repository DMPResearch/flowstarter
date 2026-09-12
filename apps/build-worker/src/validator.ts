/**
 * Trusted post-agent validation. These commands are operator-defined and run
 * outside Pi — the agent has no shell and cannot influence what runs here.
 *
 * What the agent *does* influence is the code being installed and built, and
 * that code executes for real: an Astro build runs the site's own config, its
 * integrations and whatever the install step resolved. Two consequences are
 * handled here rather than left to the host.
 *
 * - The build never sees a credential. The child environment is assembled from
 *   {@link BUILD_ENV_ALLOWLIST}, never from `process.env`, so the service-role
 *   key, the Pi key and the GitHub token stay in this process even in native
 *   mode. An allowlist is the only shape of this rule that stays correct when
 *   the next secret is added to the worker's environment.
 * - With `isolation.mode === 'docker'`, each command runs in a disposable
 *   container with exactly one bind mount — the site workspace. No host home
 *   directory, no Docker socket, no path outside the workspace, no inherited
 *   environment, no capabilities, and a pinned `corepack pnpm@<version>` as the
 *   package manager instead of whatever the host happens to have installed.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { SiteValidator } from '@flowstarter/agentic-codegen';
import {
  describeAssetProblems,
  describeCalPreviewIssue,
  describePlaceholderImageRepair,
  describePreviewTeaserIssue,
} from '@flowstarter/agentic-codegen';
import {
  DOCKER_CONTAINER_PROGRAMS,
  type DockerValidationConfig,
  type ValidatorCommand,
} from './config';
import { commandNeedsRegistry, containerNetworkFor } from './isolation';
import { findCalPreviewInDir } from './output-cal-preview';
import { findNonBinaryAssetsInDir } from './output-assets';
import { findPlaceholderImagesInDir } from './output-placeholder-images';
import { findPreviewTeaserInDir } from './output-teaser';

const execFileAsync = promisify(execFile);

export class SiteValidationError extends Error {}

/**
 * Skips trusted validation when the stub agent runs.
 *
 * The dry path materializes plain HTML with no package manifest; the real
 * validator would reject it before LocalSitePublisher can pack the site root.
 */
export class NoopSiteValidator implements SiteValidator {
  async validate(
    _workspaceRoot: string,
    _phase: 'preview' | 'full',
  ): Promise<void> {}
}

/**
 * Output lines kept per command. The tail is the useful half of a build log:
 * the summary of what was emitted, or the error that stopped it.
 */
export const VALIDATOR_OUTPUT_LINES = 200;

/**
 * Host variables a build legitimately needs: where the toolchain is, where it
 * may cache, what locale to print in, how to reach a registry. Everything else
 * is dropped — including every key that holds a credential.
 */
export const BUILD_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'COREPACK_HOME',
  'PNPM_HOME',
  'XDG_CACHE_HOME',
  'NODE_EXTRA_CA_CERTS',
  // Windows needs these to spawn anything at all.
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramFiles',
  'ProgramData',
]);

/** Locale variables, which come as a family (`LC_ALL`, `LC_CTYPE`, ...). */
const BUILD_ENV_ALLOWED_PREFIXES = ['LC_'];

/**
 * Registry reachability, which a build behind a corporate proxy cannot do
 * without. Forwarded in both isolation modes, and the one thing on this list an
 * operator should think twice about: a proxy URL can embed basic-auth.
 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/** Settings every validated build gets, whichever isolation mode it runs in. */
const BUILD_ENV_FIXED: Record<string, string> = {
  CI: '1',
  // Keep a template's postinstall/telemetry from opening network prompts or
  // writing outside the worktree.
  npm_config_ignore_scripts: 'true',
  ASTRO_TELEMETRY_DISABLED: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

/** Where the workspace is mounted inside the container. */
export const CONTAINER_WORKSPACE = '/site';
/** HOME and every cache, on a tmpfs that dies with the container. */
const CONTAINER_HOME = '/tmp/build';
/** A `docker rm -f` has no build to wait for; it either works or it is moot. */
const CONTAINER_CLEANUP_TIMEOUT_MS = 30_000;

function allowedHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Next.js augments ProcessEnv with required NODE_ENV, but a child environment
  // is deliberately partial. Do not invent NODE_ENV=production: installs need devDependencies.
  const env = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      BUILD_ENV_ALLOWLIST.has(key) ||
      BUILD_ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  return env;
}

function proxyEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = source[key]?.trim();
    if (value) env[key] = value;
  }
  return env;
}

/**
 * The environment a native-mode build command runs with: the allowlist above
 * plus the fixed build settings, and nothing the worker was configured with.
 */
export function scrubbedBuildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...allowedHostEnv(source), ...BUILD_ENV_FIXED };
}

/**
 * The environment the `docker` CLI itself runs with. It needs to find its
 * binary and its daemon; it is given nothing else, so a private registry image
 * has to be pre-pulled rather than authenticated from here.
 */
export function dockerClientEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Next.js augments ProcessEnv with required NODE_ENV, but a child environment
  // is deliberately partial. Do not invent NODE_ENV=production: installs need devDependencies.
  const env = {} as NodeJS.ProcessEnv;
  for (const key of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
  ] as const) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * The container's entire environment. Nothing is inherited: HOME and every
 * cache point at the container's own tmpfs, so the build writes only to the
 * mounted workspace and to storage that is discarded with the container.
 */
export function containerBuildEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: { registry?: boolean } = {},
): Record<string, string> {
  return {
    HOME: CONTAINER_HOME,
    XDG_CACHE_HOME: `${CONTAINER_HOME}/cache`,
    COREPACK_HOME: `${CONTAINER_HOME}/corepack`,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_cache: `${CONTAINER_HOME}/npm`,
    npm_config_store_dir: `${CONTAINER_HOME}/pnpm-store`,
    ...BUILD_ENV_FIXED,
    // A proxy URL can embed basic-auth, so it reaches only the command that
    // has a registry to talk to. `pnpm run build` gets no network and no
    // reason to be handed a credential-bearing URL.
    ...(options.registry === false ? {} : proxyEnv(source)),
  };
}

/**
 * The trusted wrapper. An operator-configured `pnpm` becomes the pinned
 * `corepack pnpm@<version>`; every other program must be one the image is
 * trusted to run. Nothing is ever concatenated into a shell string.
 */
export function containerInvocation(
  command: ValidatorCommand,
  docker: DockerValidationConfig,
): { program: string; args: string[] } {
  if (command.bin === 'pnpm') {
    return {
      program: 'corepack',
      args: [`pnpm@${docker.pnpmVersion}`, ...command.args],
    };
  }
  if (!DOCKER_CONTAINER_PROGRAMS.has(command.bin)) {
    throw new SiteValidationError(
      `Validation command "${command.bin}" is not available in the Docker ` +
        'validation image',
    );
  }
  return { program: command.bin, args: [...command.args] };
}

/** A container name docker accepts and this worker can later `rm -f`. */
export function containerName(): string {
  return `flowstarter-validate-${randomBytes(6).toString('hex')}`;
}

export interface DockerRunArgsInput {
  docker: DockerValidationConfig;
  command: ValidatorCommand;
  workspaceRoot: string;
  name: string;
  env: Record<string, string>;
  /** `uid:gid`, so build output in the mount is owned by this worker's user. */
  user: string | null;
}

/**
 * The full `docker run` argv. Exported because the argument vector *is* the
 * isolation boundary: it is worth asserting on directly, flag by flag.
 */
export function dockerRunArgs(input: DockerRunArgsInput): string[] {
  const { docker, workspaceRoot } = input;
  if (!isAbsolute(workspaceRoot) || /[,=]/.test(workspaceRoot)) {
    throw new SiteValidationError(
      `Cannot mount workspace "${workspaceRoot}": a bind source must be an ` +
        'absolute path with no "," or "="',
    );
  }
  const { program, args } = containerInvocation(input.command, docker);

  const flags = [
    'run',
    '--rm',
    // PID 1 that reaps and forwards signals, so a timeout actually stops the
    // build instead of leaving it orphaned inside the container.
    '--init',
    `--name=${input.name}`,
    // Egress per command, not per container: the install step may reach a
    // registry (or a proxy network standing in for one); everything after it,
    // `pnpm run build` included, gets `none` unless an operator says otherwise.
    `--network=${containerNetworkFor(input.command, {
      installNetwork: docker.network,
      buildNetwork: docker.buildNetwork,
    })}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    // Nothing outside the workspace and the tmpfs is writable, so a generated
    // postinstall cannot leave anything behind in the image's filesystem
    // either — the same rule the site runtime containers run under.
    '--read-only',
    `--memory=${docker.memory}`,
    `--pids-limit=${docker.pidsLimit}`,
    // The one and only mount. No host home, no Docker socket, no path outside
    // the site: a source the operator never named cannot appear in this argv.
    `--mount=type=bind,source=${workspaceRoot},target=${CONTAINER_WORKSPACE}`,
    `--workdir=${CONTAINER_WORKSPACE}`,
    `--tmpfs=/tmp:rw,exec,mode=1777,size=${docker.tmpfsSize}`,
  ];
  if (input.user) flags.push(`--user=${input.user}`);
  for (const [key, value] of Object.entries(input.env)) {
    flags.push(`--env=${key}=${value}`);
  }
  // An explicit entrypoint: the image's own is never consulted, so the program
  // that runs is the one named above and nothing else.
  flags.push(`--entrypoint=${program}`, docker.image, ...args);
  return flags;
}

export type ValidatorIsolation =
  | { mode: 'native' }
  | { mode: 'docker'; docker: DockerValidationConfig };

export interface CommandSiteValidatorOptions {
  commands: ValidatorCommand[];
  timeoutMs: number;
  /** Build output that must exist once the commands have run. */
  outputDir?: string;
  /** Defaults to native, the historical behaviour. */
  isolation?: ValidatorIsolation;
  onProgress?: (message: string) => void;
  /**
   * The last {@link VALIDATOR_OUTPUT_LINES} lines a command printed, once it
   * has finished either way. Trusted machine text: this runs outside Pi, so
   * nothing an agent wrote can reach it except as build output.
   */
  onOutput?: (command: string, lines: string[]) => void;
}

/** The tail of a command's combined output, blank lines dropped. */
function tailLines(stdout: string, stderr: string): string[] {
  return `${stdout ?? ''}\n${stderr ?? ''}`
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
    .slice(-VALIDATOR_OUTPUT_LINES);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `uid:gid` on POSIX; null on Windows, where docker has no use for it. */
function currentUser(): string | null {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.getgid !== 'function'
  ) {
    return null;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

/** One command, resolved into the process this worker will actually spawn. */
interface SpawnPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Set in docker mode: the container to force-remove if the run is killed. */
  container: string | null;
}

export class CommandSiteValidator implements SiteValidator {
  private readonly outputDir: string;
  private readonly isolation: ValidatorIsolation;

  constructor(private readonly options: CommandSiteValidatorOptions) {
    this.outputDir = options.outputDir ?? 'dist';
    this.isolation = options.isolation ?? { mode: 'native' };
  }

  async validate(
    workspaceRoot: string,
    phase: 'preview' | 'full',
  ): Promise<void> {
    if (phase !== 'full') {
      throw new SiteValidationError(
        `CommandSiteValidator only runs the full-build phase, received ${phase}`,
      );
    }

    if (!(await isFile(join(workspaceRoot, 'package.json')))) {
      throw new SiteValidationError('Built site has no package manifest');
    }
    if (!(await isDirectory(join(workspaceRoot, 'src')))) {
      throw new SiteValidationError('Built site has no source directory');
    }

    if (this.isolation.mode === 'docker') {
      const { image, network, buildNetwork, user } = this.isolation.docker;
      this.options.onProgress?.(
        `Validating in a disposable ${image} container: only the site ` +
          `workspace is mounted, read-only root, uid ${user}, network ` +
          `${network} for the install step and ${buildNetwork} for every ` +
          'other command, no host credentials',
      );
    }

    for (const command of this.options.commands) {
      const label = [command.bin, ...command.args].join(' ');
      this.options.onProgress?.(`Running ${label}`);
      const plan = this.planFor(command, workspaceRoot);
      try {
        const { stdout, stderr } = await execFileAsync(plan.bin, plan.args, {
          cwd: workspaceRoot,
          encoding: 'utf8',
          timeout: this.options.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: plan.env,
        });
        this.options.onOutput?.(label, tailLines(stdout, stderr));
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        // The output of the command that failed is the whole point of a build
        // log, so it is reported before the error that hides it in a message.
        this.options.onOutput?.(
          label,
          tailLines(failure.stdout ?? '', failure.stderr ?? failure.message),
        );
        // `docker run --rm` cleans up after itself on any ordinary exit. A
        // killed client is the case it cannot cover: the daemon still owns a
        // running container, so it is removed by name before this throws.
        if (plan.container) await this.removeContainer(plan.container);
        if (failure.killed) {
          throw new SiteValidationError(
            `Validation command "${label}" timed out after ${this.options.timeoutMs}ms`,
          );
        }
        const detail = (failure.stderr || failure.stdout || failure.message)
          .toString()
          .trim()
          .slice(-2_000);
        throw new SiteValidationError(
          `Validation command "${label}" failed: ${detail}`,
        );
      }
    }

    const output = join(workspaceRoot, this.outputDir);
    if (!(await isDirectory(output))) {
      throw new SiteValidationError(
        `Build produced no ${this.outputDir}/ output directory`,
      );
    }

    // The build succeeding says nothing about whether its images are images.
    // Base64 that lost its `encoding` flag lands on disk as an ASCII file
    // named `.png`, and every step after this one — pack, deploy, serve — is
    // happy to carry it. This is the last place the bytes are still on disk
    // and the job can still be failed.
    const problems = await findNonBinaryAssetsInDir(output);
    if (problems.length > 0) {
      const message = describeAssetProblems(problems);
      this.options.onOutput?.('asset-binary-gate', [message]);
      throw new SiteValidationError(message);
    }

    // This validator only ever runs the `full` phase, which is a paid build or
    // a client rebuild. The funnel preview teaser blurs the lower half of
    // every page and offers to sell the client a site they have already paid
    // for; it shipped once, on all ten pages of a delivered portfolio.
    const teaser = await findPreviewTeaserInDir(output);
    if (teaser.length > 0) {
      const message = describePreviewTeaserIssue(teaser);
      this.options.onOutput?.('preview-teaser-gate', [message]);
      throw new SiteValidationError(message);
    }

    // Same shape, same reason: the funnel preview's blurred calendar demo is
    // a teaser, not a promise, and it shipped on a delivered portfolio's
    // contact page because nothing removed it once the workspace turned out
    // to have no booking link to back a real one.
    const calPreview = await findCalPreviewInDir(output);
    if (calPreview.length > 0) {
      const message = describeCalPreviewIssue(calPreview);
      this.options.onOutput?.('cal-preview-gate', [message]);
      throw new SiteValidationError(message);
    }

    // The gate of record for placeholder images: the agent-side repair pass
    // in `workflows.ts` can only see the site's text and so can miss a
    // renamed copy or a fallback the agent never touched. This reads the
    // actual bytes in `dist/`, so a portrait or work-thumb placeholder is
    // caught by hash even if nothing referencing it survived as a string.
    const placeholderImages = await findPlaceholderImagesInDir(output);
    if (placeholderImages.length > 0) {
      // The repair brief, not the bare verdict: this message is read back to
      // an agent as "the output was ...", and a change-request agent is only
      // allowed to delete a file under `public/` that this names by path.
      const message = describePlaceholderImageRepair(placeholderImages);
      this.options.onOutput?.('placeholder-image-gate', [message]);
      throw new SiteValidationError(message);
    }
  }

  private planFor(command: ValidatorCommand, workspaceRoot: string): SpawnPlan {
    if (this.isolation.mode !== 'docker') {
      return {
        bin: command.bin,
        args: command.args,
        env: scrubbedBuildEnv(),
        container: null,
      };
    }
    const docker = this.isolation.docker;
    const name = containerName();
    return {
      bin: docker.bin,
      args: dockerRunArgs({
        docker,
        command,
        workspaceRoot,
        name,
        env: containerBuildEnv(process.env, {
          registry: commandNeedsRegistry(command),
        }),
        // The uid was resolved and refused-if-root at boot (`config.ts`), so
        // by here it is a non-root pair this worker can read output back from.
        user: docker.user || currentUser(),
      }),
      env: dockerClientEnv(),
      container: name,
    };
  }

  private async removeContainer(name: string): Promise<void> {
    if (this.isolation.mode !== 'docker') return;
    try {
      await execFileAsync(
        this.isolation.docker.bin,
        ['rm', '--force', '--volumes', name],
        {
          encoding: 'utf8',
          timeout: CONTAINER_CLEANUP_TIMEOUT_MS,
          windowsHide: true,
          env: dockerClientEnv(),
        },
      );
    } catch {
      // Either the container was already gone (the ordinary case, `--rm` having
      // done it) or the daemon is unreachable. Neither is worth replacing the
      // build failure the caller is about to be told about.
    }
  }
}
