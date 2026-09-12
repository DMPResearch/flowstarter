/**
 * Where a generated build is allowed to execute.
 *
 * Validation is the one step that runs code an agent wrote: `pnpm run build`
 * executes the site's own Astro config, its integrations and whatever the
 * install resolved. Native mode runs all of that as this worker's user, with
 * this worker's filesystem — which means a generated `astro.config.mjs` can
 * read a neighbouring client's worktree, `/etc/flowstarter/*`, or the worker's
 * own `.env`. Scrubbing the child environment (see `validator.ts`) removes the
 * credentials from the *process*; it does nothing about the credentials on
 * *disk*.
 *
 * So the mode is a rule of the environment, not an operator preference:
 *
 *   development, test -> native unless asked otherwise (no daemon required)
 *   staging, production -> docker, always; `native` is refused at boot
 *
 * Everything here is pure. `config.ts` turns a refusal into a `ConfigError`
 * that stops the process; `validator.ts` turns the resolved mode into an
 * argument vector.
 */

export type ValidatorIsolationMode = 'native' | 'docker';

/** The canonical variable. */
export const ISOLATION_ENV_KEY = 'FLOWSTARTER_BUILD_ISOLATION';
/** The name this setting shipped under, still honoured. */
export const LEGACY_ISOLATION_ENV_KEY = 'FLOWSTARTER_BUILD_VALIDATE_ISOLATION';

/**
 * Environments where a client's real, paid build runs, and therefore the two
 * where a generated build may never touch the host filesystem.
 */
export const ISOLATION_REQUIRED_ENVS: ReadonlySet<string> = new Set([
  'staging',
  'production',
]);

export type IsolationResolution =
  | {
      ok: true;
      mode: ValidatorIsolationMode;
      /** `default` means nobody asked; the environment decided. */
      source: 'default' | 'explicit';
    }
  | { ok: false; error: string };

function normalize(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

/**
 * The isolation mode for one worker, from what was asked for and where it runs.
 */
export function resolveIsolationMode(input: {
  requested?: string | undefined;
  legacyRequested?: string | undefined;
  flowstarterEnv: string;
}): IsolationResolution {
  const requested = normalize(input.requested);
  const legacy = normalize(input.legacyRequested);
  if (requested && legacy && requested !== legacy) {
    return {
      ok: false,
      error:
        `${ISOLATION_ENV_KEY} says "${requested}" and ${LEGACY_ISOLATION_ENV_KEY} ` +
        `says "${legacy}". Set one of them, not two that disagree.`,
    };
  }
  const asked = requested ?? legacy;
  const isolationRequired = ISOLATION_REQUIRED_ENVS.has(input.flowstarterEnv);

  if (asked === null) {
    return {
      ok: true,
      mode: isolationRequired ? 'docker' : 'native',
      source: 'default',
    };
  }
  if (asked !== 'native' && asked !== 'docker') {
    return {
      ok: false,
      error: `${ISOLATION_ENV_KEY} must be "native" or "docker", received "${asked}"`,
    };
  }
  if (asked === 'native' && isolationRequired) {
    return {
      ok: false,
      error:
        `${ISOLATION_ENV_KEY}=native is refused when the resolved environment ` +
        `is staging or production (got "${input.flowstarterEnv}"). A generated ` +
        "Astro config and its build scripts run as this worker's user in " +
        'native mode and can read every file that user can — neighbouring ' +
        "client worktrees, /etc/flowstarter, this worker's own .env. Use " +
        `${ISOLATION_ENV_KEY}=docker, which is also the default there.`,
    };
  }
  return { ok: true, mode: asked, source: 'explicit' };
}

/**
 * The first argument of a validation command, which is the only place a
 * package manager names its subcommand.
 */
const REGISTRY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install',
  'i',
  'add',
  'ci',
  'fetch',
  'import',
  'update',
  'up',
  'dlx',
  'exec',
]);

/**
 * True when this command has to reach a registry.
 *
 * The install step does; `pnpm run build` does not, and a generated site that
 * wants to phone home from its build is exactly the thing worth stopping. The
 * subcommand is read from `args[0]` only, so `pnpm run install-fonts` is a
 * build script, not an install.
 */
export function commandNeedsRegistry(command: {
  bin: string;
  args: string[];
}): boolean {
  const subcommand = command.args[0];
  return typeof subcommand === 'string' && REGISTRY_SUBCOMMANDS.has(subcommand);
}

export interface ContainerNetworks {
  /** What the install step gets. `bridge`, or a named proxy network. */
  installNetwork: string;
  /** What every other command gets. `none` by default. */
  buildNetwork: string;
}

/** Egress per command, decided by the rule above. */
export function containerNetworkFor(
  command: { bin: string; args: string[] },
  networks: ContainerNetworks,
): string {
  return commandNeedsRegistry(command)
    ? networks.installNetwork
    : networks.buildNetwork;
}

export type ContainerUserResolution =
  | { ok: true; user: string }
  | { ok: false; error: string };

const UID_GID = /^([0-9]{1,10}):([0-9]{1,10})$/;

/**
 * The uid:gid the build runs as inside the container.
 *
 * The default is this worker's own user, so build output in the bind mount is
 * owned by the process that has to read it back. Root is refused rather than
 * silently accepted: a container whose build runs as uid 0 writes root-owned
 * files into the host worktree and hands a generated postinstall the one
 * identity `--cap-drop=ALL` does not take away. A worker that genuinely runs
 * as root has to name a non-root uid explicitly.
 */
export function resolveContainerUser(input: {
  uid: number | null;
  gid: number | null;
  configured?: string | undefined;
}): ContainerUserResolution {
  const configured = normalize(input.configured);
  if (configured) {
    const match = UID_GID.exec(configured);
    if (!match) {
      return {
        ok: false,
        error:
          'FLOWSTARTER_BUILD_VALIDATE_DOCKER_USER must be "uid:gid", such as "1000:1000"',
      };
    }
    if (match[1] === '0') {
      return {
        ok: false,
        error:
          'FLOWSTARTER_BUILD_VALIDATE_DOCKER_USER may not be uid 0: a generated ' +
          'build must never run as root, even inside a container',
      };
    }
    return { ok: true, user: configured };
  }

  // No uid to read (Windows, or a platform without POSIX ids). There is no
  // host ownership to match, so the image's conventional non-root user stands.
  if (input.uid === null || input.gid === null) {
    return { ok: true, user: DEFAULT_CONTAINER_USER };
  }
  if (input.uid === 0) {
    return {
      ok: false,
      error:
        'This worker is running as root, so the isolated build would run as ' +
        'root too. Run the worker as an ordinary user, or set ' +
        'FLOWSTARTER_BUILD_VALIDATE_DOCKER_USER to a non-root "uid:gid" that ' +
        'owns the worktrees root.',
    };
  }
  return { ok: true, user: `${input.uid}:${input.gid}` };
}

/** `node:22-bookworm-slim` ships uid 1000 as `node`. */
export const DEFAULT_CONTAINER_USER = '1000:1000';
