/**
 * Environment contract for the private Pi build worker.
 *
 * Every value is validated once at boot so a misconfigured host fails loudly
 * instead of half-running a client's paid build. Nothing here is ever sent to
 * a model: the Pi API key, the service-role key and the GitHub token stay in
 * this process.
 */

import { resolvePlatformDomain } from '@flowstarter/platform-config';

export interface ValidatorCommand {
  bin: string;
  args: string[];
}

/**
 * Where the trusted install/build commands actually execute.
 *
 * `native` is the historical path: the commands run on the build host as this
 * process's user. `docker` runs each one inside a disposable container with
 * only the site workspace mounted — no host credentials, no Docker socket, no
 * home directory, nothing outside the workspace. It has to be asked for
 * explicitly, because it needs a working Docker daemon on the host and a
 * half-configured one must fail loudly rather than silently fall back to
 * running a generated Astro build next to the service-role key.
 */
export type ValidatorIsolationMode = 'native' | 'docker';

/**
 * Programs the validation image is trusted to run directly. A command is never
 * assembled from tenant text or handed to a shell: `pnpm` is rewritten to the
 * pinned `corepack pnpm@<version>` wrapper, and anything outside this set is
 * refused at boot.
 */
export const DOCKER_CONTAINER_PROGRAMS: ReadonlySet<string> = new Set([
  'corepack',
  'node',
  'npm',
  'npx',
  'pnpm',
]);

export interface DockerValidationConfig {
  /** The Docker CLI itself, on this worker's PATH. Bare executable name. */
  bin: string;
  /** Node 22 by default; the site toolchain comes from the image, not the host. */
  image: string;
  /**
   * `bridge` — an install has to reach a registry. `none` is available for a
   * pre-populated workspace, where the build must touch no network at all.
   */
  network: 'bridge' | 'none';
  /** Container memory cap, docker size syntax (`4g`, `512m`). */
  memory: string;
  /** Size of the container's `/tmp`, which holds HOME and every cache. */
  tmpfsSize: string;
  /** Fork-bomb ceiling for the build. */
  pidsLimit: number;
  /** pnpm pinned through corepack *inside* the container. */
  pnpmVersion: string;
}

/**
 * How a finished build reaches a reviewer.
 *
 * `github` is production: push the client branch and open the internal draft
 * PR that gates HUMAN_QA. `local` is the dev/dry path: package the build
 * output into a tarball, serve it off this worker, and ask flowstarter-main to
 * deploy it through the ordinary `deploySite` → deploy-agent route. Local mode
 * needs no GitHub credentials and no Hetzner host, which is the whole point:
 * the ledger → build → deploy → serve chain can be exercised end to end on a
 * laptop.
 */
export type PublishMode = 'github' | 'local';

export interface LocalPublishConfig {
  /** Where packaged tarballs are written and served from. */
  artifactsRoot: string;
  /** Base URL the deploy-agent will fetch artifacts from. */
  artifactBaseUrl: string;
  /** flowstarter-main, which owns `deploySite` and the deployments ledger. */
  flowstarterMainUrl: string;
  /**
   * Directory inside the built site to package, relative to the site root.
   * Falls back to the site root itself when it does not exist, so a manifest
   * that is already plain HTML still deploys.
   */
  outputDir: string;
  /**
   * Replace the Pi coding session with a deterministic pass that only
   * materializes and marks the approved preview. Lets CI and a laptop without
   * a model key still drive the whole chain.
   */
  stubAgent: boolean;
}

export interface WorkerConfig {
  port: number;
  hostname: string;
  sharedSecret: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  publishMode: PublishMode;
  pi: {
    provider: string;
    modelId: string;
    apiKey: string;
    thinkingLevel:
      | 'off'
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'max';
    timeoutMs: number;
  };
  git: {
    repositoryRoot: string;
    worktreesRoot: string;
    baseRef: string;
    remote: string;
  };
  /** Null in local mode, where no PR is opened and no token is needed. */
  github: {
    apiBaseUrl: string;
    owner: string;
    repo: string;
    token: string;
  } | null;
  /** Null in github mode. */
  local: LocalPublishConfig | null;
  stagingUrlTemplate: string;
  validateCommands: ValidatorCommand[];
  validateIsolation: ValidatorIsolationMode;
  /** Null unless `validateIsolation` is `docker`. */
  validateDocker: DockerValidationConfig | null;
  /**
   * Swaps in `NoopSiteValidator` (see `validator.ts`) for every job kind.
   * This is the *only* switch that may do that: `local.stubAgent` replaces
   * just the Pi coding session (see `agents` in `index.ts`), never the
   * validator. Unit-test-only by design — `loadConfig` refuses it outright
   * when the resolved environment is staging or production, so a
   * misconfigured host can never boot with the real build gate silently
   * disabled.
   */
  skipValidation: boolean;
  buildTimeoutMs: number;
  maxAttempts: number;
  concurrency: number;
  queueLimit: number;
  /**
   * How often the worker asks the database what it should be running, rather
   * than waiting to be told. Dispatch is an HTTP nudge and every way it can be
   * lost -- a restart, a deploy, an unreachable host, a brief a client
   * finished at two in the morning -- leaves a paid build nobody picks up.
   *
   * A minute is short enough that no client notices and long enough that this
   * is one small indexed query per minute per worker.
   */
  pollIntervalMs: number;
  /** Most jobs one reconciliation sweep considers, so a backlog is paced. */
  pollLimit: number;
}

const THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * A template site is installed and built with trusted, operator-defined
 * commands run outside Pi. `--ignore-scripts` keeps template dependencies from
 * executing lifecycle hooks on the build host.
 */
const DEFAULT_VALIDATE_COMMANDS: ValidatorCommand[] = [
  { bin: 'pnpm', args: ['install', '--ignore-scripts', '--prefer-offline'] },
  { bin: 'pnpm', args: ['run', 'build'] },
];

/**
 * execFile never goes through a shell, but a name containing a separator would
 * let an operator typo escape the intended toolchain, and one starting with `-`
 * would be read as a flag by whatever it is passed to.
 */
const BARE_EXECUTABLE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

const DEFAULT_DOCKER_IMAGE = 'node:22-bookworm-slim';
/**
 * Pinned by this worker, never read from the host or from the generated site's
 * own manifest: the package manager that installs tenant code is part of the
 * trusted wrapper, not part of the build's input.
 */
const DEFAULT_DOCKER_PNPM_VERSION = '10.29.2';

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

function optionalNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `${key} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  }
  return value;
}

function parseValidateCommands(raw: string | undefined): ValidatorCommand[] {
  if (!raw?.trim()) return DEFAULT_VALIDATE_COMMANDS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_COMMANDS must be a JSON array of string arrays',
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_COMMANDS must contain at least one command',
    );
  }
  return parsed.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length === 0 ||
      entry.some((part) => typeof part !== 'string' || part.length === 0)
    ) {
      throw new ConfigError(
        'Each validate command must be a non-empty array of non-empty strings',
      );
    }
    const [bin, ...args] = entry as string[];
    if (!BARE_EXECUTABLE.test(bin as string)) {
      throw new ConfigError(
        `Validate command "${bin}" is not a bare executable name`,
      );
    }
    return { bin: bin as string, args };
  });
}

function parseValidatorIsolation(
  raw: string | undefined,
): ValidatorIsolationMode {
  const mode = raw?.trim() || 'native';
  if (mode !== 'native' && mode !== 'docker') {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_ISOLATION must be "native" or "docker", ' +
        `received "${mode}"`,
    );
  }
  return mode;
}

/** A docker size argument: `512m`, `4g`. Rejects anything else outright. */
function parseDockerSize(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*[kmg]$/i.test(raw)) {
    throw new ConfigError(
      `${key} must be a docker size such as "512m" or "4g"`,
    );
  }
  return raw;
}

function parseDockerValidation(
  env: NodeJS.ProcessEnv,
  commands: ValidatorCommand[],
): DockerValidationConfig {
  for (const command of commands) {
    if (!DOCKER_CONTAINER_PROGRAMS.has(command.bin)) {
      throw new ConfigError(
        `Validate command "${command.bin}" is not available in the Docker ` +
          'validation image; supported programs are ' +
          `${Array.from(DOCKER_CONTAINER_PROGRAMS).sort().join(', ')}`,
      );
    }
  }

  const bin = env.FLOWSTARTER_BUILD_VALIDATE_DOCKER_BIN?.trim() || 'docker';
  if (!BARE_EXECUTABLE.test(bin)) {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_DOCKER_BIN must be a bare executable name',
    );
  }

  const image =
    env.FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE?.trim() || DEFAULT_DOCKER_IMAGE;
  // A reference, not a flag and not a shell fragment: this value is passed
  // straight to `docker run` as argv.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image)) {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE is not a valid image reference',
    );
  }

  const network =
    env.FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK?.trim() || 'bridge';
  if (network !== 'bridge' && network !== 'none') {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK must be "bridge" or "none", ' +
        `received "${network}"`,
    );
  }

  const pnpmVersion =
    env.FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION?.trim() ||
    DEFAULT_DOCKER_PNPM_VERSION;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/.test(pnpmVersion)) {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION must be an exact version such ' +
        `as "${DEFAULT_DOCKER_PNPM_VERSION}"`,
    );
  }

  return {
    bin,
    image,
    network,
    memory: parseDockerSize(
      env,
      'FLOWSTARTER_BUILD_VALIDATE_DOCKER_MEMORY',
      '4g',
    ),
    tmpfsSize: parseDockerSize(
      env,
      'FLOWSTARTER_BUILD_VALIDATE_DOCKER_TMPFS_SIZE',
      '2g',
    ),
    pidsLimit: optionalNumber(
      env,
      'FLOWSTARTER_BUILD_VALIDATE_DOCKER_PIDS_LIMIT',
      1_024,
      { min: 64, max: 16_384 },
    ),
    pnpmVersion,
  };
}

function parseRepository(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(value);
  if (!match) {
    throw new ConfigError(
      'FLOWSTARTER_SITES_REPO must be in "owner/repo" form',
    );
  }
  return { owner: match[1] as string, repo: match[2] as string };
}

function parsePublishMode(raw: string | undefined): PublishMode {
  const mode = raw?.trim() || 'github';
  if (mode !== 'github' && mode !== 'local') {
    throw new ConfigError(
      `FLOWSTARTER_BUILD_MODE must be "github" or "local", received "${mode}"`,
    );
  }
  return mode;
}

function parseHttpUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${key} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${key} must be an http(s) URL`);
  }
  return value.replace(/\/$/, '');
}

/**
 * The same four values `resolveFlowstarterEnv` (flowstarter-main) resolves
 * to, computed locally rather than imported: this is a private Pi worker
 * with its own `tsconfig`/module setup, and the two apps agree on the *rule*
 * (`FLOWSTARTER_ENV`, falling back to `NODE_ENV`) rather than sharing code
 * across an app boundary neither is meant to depend on.
 */
const KNOWN_FLOWSTARTER_ENVS = new Set([
  'development',
  'test',
  'staging',
  'production',
]);

function resolveWorkerFlowstarterEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.FLOWSTARTER_ENV?.trim();
  if (raw && KNOWN_FLOWSTARTER_ENVS.has(raw)) return raw;
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'development';
}

/**
 * `FLOWSTARTER_BUILD_SKIP_VALIDATION` is the *only* thing allowed to swap in
 * `NoopSiteValidator` — never `FLOWSTARTER_BUILD_STUB_AGENT`, which
 * replaces just the Pi coding session. It exists for this worker's own unit
 * tests, which is why a host whose resolved environment is staging or
 * production refuses to boot with it set: those are exactly the two
 * environments where a client's build must never skip the real
 * `pnpm install && pnpm run build` gate.
 */
function parseSkipValidation(env: NodeJS.ProcessEnv): boolean {
  const requested = env.FLOWSTARTER_BUILD_SKIP_VALIDATION === 'true';
  if (!requested) return false;

  const resolvedEnv = resolveWorkerFlowstarterEnv(env);
  if (resolvedEnv === 'staging' || resolvedEnv === 'production') {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_SKIP_VALIDATION is unit-test-only and is refused ' +
        `when the resolved environment is staging or production (got "${resolvedEnv}")`,
    );
  }
  return true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const sharedSecret = required(env, 'FLOWSTARTER_BUILD_WORKER_SECRET');
  if (sharedSecret.length < 32) {
    throw new ConfigError(
      'FLOWSTARTER_BUILD_WORKER_SECRET must be at least 32 characters',
    );
  }

  const publishMode = parsePublishMode(env.FLOWSTARTER_BUILD_MODE);
  const port = optionalNumber(env, 'FLOWSTARTER_BUILD_WORKER_PORT', 8787, {
    min: 1,
    max: 65_535,
  });
  // A stub agent is only meaningful in local mode; production must never
  // silently ship a site nothing personalized.
  const stubAgent =
    publishMode === 'local' && env.FLOWSTARTER_BUILD_STUB_AGENT === 'true';

  const piApiKey =
    env.PI_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim() || '';
  if (!piApiKey && !stubAgent) {
    throw new ConfigError(
      'PI_API_KEY (or OPENROUTER_API_KEY) is required ' +
        '(or set FLOWSTARTER_BUILD_MODE=local with FLOWSTARTER_BUILD_STUB_AGENT=true)',
    );
  }

  const thinkingLevel = env.PI_THINKING_LEVEL?.trim() || 'medium';
  if (!THINKING_LEVELS.has(thinkingLevel)) {
    throw new ConfigError(
      `PI_THINKING_LEVEL "${thinkingLevel}" is not supported`,
    );
  }

  // Local mode is expected to run on a laptop with nothing provisioned, so the
  // git roots get defaults there. Production still has to say where they are.
  const repositoryRoot =
    publishMode === 'local'
      ? env.FLOWSTARTER_REPOSITORY_ROOT?.trim() ||
        '/tmp/flowstarter-local/repository'
      : required(env, 'FLOWSTARTER_REPOSITORY_ROOT');
  const worktreesRoot =
    publishMode === 'local'
      ? env.FLOWSTARTER_WORKTREES_ROOT?.trim() ||
        '/tmp/flowstarter-local/worktrees'
      : required(env, 'FLOWSTARTER_WORKTREES_ROOT');
  if (!repositoryRoot.startsWith('/') || !worktreesRoot.startsWith('/')) {
    throw new ConfigError(
      'FLOWSTARTER_REPOSITORY_ROOT and FLOWSTARTER_WORKTREES_ROOT must be absolute paths',
    );
  }

  // Same env-driven rule as the app's own preview hostnames
  // (`resolvePlatformDomain` in `@flowstarter/platform-config`): a
  // development or staging worker's default staging URL sits on
  // `staging.flowstarter.dev` (matching `deploy/hetzner-staging`), and only
  // a worker whose FLOWSTARTER_ENV/NODE_ENV says production defaults to
  // `staging.flowstarter.net`.
  const stagingUrlTemplate =
    env.FLOWSTARTER_STAGING_URL_TEMPLATE?.trim() ||
    (publishMode === 'local'
      ? 'http://localhost:8788/{projectId}/'
      : `https://{projectId}.staging.${resolvePlatformDomain({
          flowstarterEnv: env.FLOWSTARTER_ENV,
          nodeEnv: env.NODE_ENV,
        })}`);
  if (!stagingUrlTemplate.includes('{projectId}')) {
    throw new ConfigError(
      'FLOWSTARTER_STAGING_URL_TEMPLATE must contain the {projectId} placeholder',
    );
  }
  // Local mode serves from loopback, where there is no certificate to have.
  if (publishMode !== 'local' && !stagingUrlTemplate.startsWith('https://')) {
    throw new ConfigError('FLOWSTARTER_STAGING_URL_TEMPLATE must be https');
  }

  const validateCommands = parseValidateCommands(
    env.FLOWSTARTER_BUILD_VALIDATE_COMMANDS,
  );
  const validateIsolation = parseValidatorIsolation(
    env.FLOWSTARTER_BUILD_VALIDATE_ISOLATION,
  );
  const skipValidation = parseSkipValidation(env);

  return {
    port,
    hostname: env.FLOWSTARTER_BUILD_WORKER_HOST?.trim() || '0.0.0.0',
    sharedSecret,
    supabaseUrl: required(env, 'NEXT_PUBLIC_SUPABASE_URL'),
    supabaseServiceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    publishMode,
    pi: {
      provider: env.PI_PROVIDER?.trim() || 'openrouter',
      modelId: env.PI_MODEL?.trim() || 'z-ai/glm-5.2',
      apiKey: piApiKey,
      thinkingLevel: thinkingLevel as WorkerConfig['pi']['thinkingLevel'],
      timeoutMs: optionalNumber(env, 'PI_TIMEOUT_MS', 1_800_000, {
        min: 60_000,
        max: 7_200_000,
      }),
    },
    git: {
      repositoryRoot,
      worktreesRoot,
      baseRef: env.FLOWSTARTER_SITES_BASE_REF?.trim() || 'main',
      remote: env.FLOWSTARTER_SITES_REMOTE?.trim() || 'origin',
    },
    github:
      publishMode === 'github'
        ? {
            apiBaseUrl:
              env.GITHUB_API_BASE_URL?.trim().replace(/\/$/, '') ||
              'https://api.github.com',
            ...parseRepository(required(env, 'FLOWSTARTER_SITES_REPO')),
            token: required(env, 'FLOWSTARTER_SITES_GITHUB_TOKEN'),
          }
        : null,
    local:
      publishMode === 'local'
        ? {
            artifactsRoot:
              env.FLOWSTARTER_BUILD_ARTIFACTS_ROOT?.trim() ||
              '/tmp/flowstarter-build-artifacts',
            artifactBaseUrl: parseHttpUrl(
              env.FLOWSTARTER_BUILD_ARTIFACT_BASE_URL?.trim() ||
                `http://127.0.0.1:${port}`,
              'FLOWSTARTER_BUILD_ARTIFACT_BASE_URL',
            ),
            flowstarterMainUrl: parseHttpUrl(
              env.FLOWSTARTER_MAIN_URL?.trim() || 'http://127.0.0.1:3000',
              'FLOWSTARTER_MAIN_URL',
            ),
            outputDir: env.FLOWSTARTER_BUILD_OUTPUT_DIR?.trim() || 'dist',
            stubAgent,
          }
        : null,
    stagingUrlTemplate,
    validateCommands,
    validateIsolation,
    validateDocker:
      validateIsolation === 'docker'
        ? parseDockerValidation(env, validateCommands)
        : null,
    skipValidation,
    buildTimeoutMs: optionalNumber(
      env,
      'FLOWSTARTER_BUILD_TIMEOUT_MS',
      900_000,
      {
        min: 30_000,
        max: 3_600_000,
      },
    ),
    maxAttempts: optionalNumber(env, 'FLOWSTARTER_BUILD_MAX_ATTEMPTS', 3, {
      min: 1,
      max: 10,
    }),
    concurrency: optionalNumber(env, 'FLOWSTARTER_BUILD_CONCURRENCY', 1, {
      min: 1,
      max: 4,
    }),
    queueLimit: optionalNumber(env, 'FLOWSTARTER_BUILD_QUEUE_LIMIT', 32, {
      min: 1,
      max: 512,
    }),
    pollIntervalMs: optionalNumber(
      env,
      'FLOWSTARTER_BUILD_POLL_INTERVAL_MS',
      60_000,
      { min: 5_000, max: 900_000 },
    ),
    pollLimit: optionalNumber(env, 'FLOWSTARTER_BUILD_POLL_LIMIT', 25, {
      min: 1,
      max: 200,
    }),
  };
}
