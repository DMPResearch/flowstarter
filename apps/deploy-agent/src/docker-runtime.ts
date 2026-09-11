/**
 * `DEPLOY_AGENT_SITE_RUNTIME=docker` — each site runs in its own container
 * instead of being extracted straight into `SITES_ROOT`. Everything that
 * talks to the Docker CLI or the network lives here, behind interfaces the
 * tests replace, so the runtime contract (argv, ownership labels,
 * rollback, readiness) is checked without a real daemon.
 *
 * Blue/green per slug: two container name slots, `a` and `b`. A deploy
 * always builds and starts the slot that is NOT currently running, health
 * checks it on its own loopback port, and only then asks the caller to
 * cut Caddy over. The slot that was serving before is removed only after
 * the cutover succeeds — so a failed build, a failed health check or a
 * failed Caddy reload all leave the previous container serving.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { safeExtractTarball } from './tar-safety';
import { DOCKERFILE_TEMPLATE_NAME, type SiteRuntimeTemplates } from './site-templates';

export type SiteMode = 'sites' | 'previews';
export type Slot = 'a' | 'b';

const NAMESPACE = 'fs-deploy';
export const LABEL_OWNER = 'flowstarter.deploy-agent';
export const LABEL_MODE = 'flowstarter.mode';
export const LABEL_SLUG = 'flowstarter.slug';
export const LABEL_SLOT = 'flowstarter.slot';

export function containerName(mode: SiteMode, slug: string, slot: Slot): string {
  return `${NAMESPACE}-${mode}-${slug}-${slot}`;
}

export function imageName(mode: SiteMode, slug: string, sha256: string): string {
  return `${NAMESPACE}-${mode}-${slug}:${sha256.slice(0, 16)}`;
}

export function otherSlot(slot: Slot): Slot {
  return slot === 'a' ? 'b' : 'a';
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `bin` with `args` as argv — never a shell string, so nothing in a
 * slug, a domain or an image tag is ever interpolated into a command
 * line. */
export type CommandRunner = (bin: string, args: string[]) => Promise<CommandResult>;

export const systemCommandRunner: CommandRunner = (bin, args) =>
  new Promise((resolvePromise) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (err) => resolvePromise({ code: 1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });

export type ReadinessCheck = (url: string) => Promise<boolean>;

/**
 * Ready means the container served the site's index at `/` with a 200.
 *
 * The earlier bar, `status < 500`, treated a 404 as ready — which is
 * exactly what a container whose `/srv` came out empty returns, so a build
 * that produced no `index.html` would have passed readiness and been cut
 * over to. A redirect is not ready either: `redirect: 'manual'` keeps fetch
 * from following one and reporting the destination's status as this
 * container's.
 */
export const httpReadinessCheck: ReadinessCheck = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
};

const DOCKER_BIN = process.env.DEPLOY_AGENT_DOCKER_BIN ?? 'docker';

function ownershipLabelArgs(mode: SiteMode, slug: string): string[] {
  return [
    '--label',
    `${LABEL_OWNER}=true`,
    '--label',
    `${LABEL_MODE}=${mode}`,
    '--label',
    `${LABEL_SLUG}=${slug}`,
  ];
}

async function runDocker(
  runner: CommandRunner,
  args: string[]
): Promise<CommandResult> {
  return runner(DOCKER_BIN, args);
}

export interface ContainerFacts {
  /** Image ID (`sha256:…`) the container was created from. */
  imageId: string | null;
  /** True only when every one of this agent's ownership labels matches. */
  owned: boolean;
}

/** Cannot appear in an image ID, a mode, or a slug (see `SLUG_RE`). */
const INSPECT_SEPARATOR = '|';

/**
 * Reads the image and the ownership labels of `name` in one call, or
 * `null` when no container by that name exists.
 *
 * Everything destructive goes through this first. `docker rm -f <name>`
 * with a name the agent merely *expects* to own will happily destroy a
 * container somebody else put on the host under a colliding name; asking
 * the daemon who owns it costs one call and makes that impossible.
 */
export async function inspectContainer(
  runner: CommandRunner,
  mode: SiteMode,
  slug: string,
  name: string
): Promise<ContainerFacts | null> {
  const format = [
    '{{.Image}}',
    `{{index .Config.Labels "${LABEL_OWNER}"}}`,
    `{{index .Config.Labels "${LABEL_MODE}"}}`,
    `{{index .Config.Labels "${LABEL_SLUG}"}}`,
  ].join(INSPECT_SEPARATOR);
  // `container inspect`, not the bare `inspect` that also matches images:
  // an image sharing a container's name must not answer for it.
  const res = await runDocker(runner, ['container', 'inspect', '--format', format, name]);
  if (res.code !== 0) return null;
  const [imageId, owner, containerMode, containerSlug] = res.stdout
    .trim()
    .split(INSPECT_SEPARATOR);
  return {
    imageId: imageId?.trim() || null,
    owned: owner === 'true' && containerMode === mode && containerSlug === slug,
  };
}

/**
 * Removes `name` only if this agent owns it. Returns false when a
 * container by that name exists but carries somebody else's labels (or
 * none) — the caller then has to fail the deploy rather than take the
 * slot, because the alternative is deleting a stranger's container.
 *
 * Never throws: a deploy that already failed should not fail again while
 * cleaning up after itself.
 */
export async function removeOwnedContainer(
  runner: CommandRunner,
  mode: SiteMode,
  slug: string,
  name: string
): Promise<{ removed: boolean; conflicted: boolean; imageId: string | null }> {
  const facts = await inspectContainer(runner, mode, slug, name).catch(() => null);
  if (!facts) return { removed: false, conflicted: false, imageId: null };
  if (!facts.owned) return { removed: false, conflicted: true, imageId: facts.imageId };
  await runDocker(runner, ['rm', '-f', name]).catch(() => undefined);
  return { removed: true, conflicted: false, imageId: facts.imageId };
}

/**
 * Deletes an image, unless it is one of `protectedImageIds` or the daemon
 * says something is still using it.
 *
 * Two guards, because `imageName()` is derived from the artifact sha256:
 * redeploying an unchanged artifact reuses the tag the live container was
 * started from.
 *
 * The `-f` this used to pass is the dangerous part. Plain `docker rmi`
 * refuses an image a container references ("must be forced ... container
 * 412e15 is using its referenced image"); `docker rmi -f` untags it
 * anyway and leaves the running site on a dangling image, which the next
 * `docker image prune` reaps and the next reboot cannot restart from. Not
 * forcing turns the daemon itself into the check.
 */
export async function removeImageUnlessProtected(
  runner: CommandRunner,
  image: string | null,
  protectedImageIds: readonly (string | null)[]
): Promise<void> {
  if (!image) return;
  const protectedIds = new Set(
    protectedImageIds.filter((id): id is string => !!id)
  );
  if (protectedIds.size > 0) {
    if (protectedIds.has(image)) return;
    const id = await resolveImageId(runner, image);
    if (id && protectedIds.has(id)) return;
  }
  await runDocker(runner, ['rmi', image]).catch(() => undefined);
}

/** Resolves a tag or ID to its canonical image ID, or null if unknown. */
async function resolveImageId(
  runner: CommandRunner,
  image: string
): Promise<string | null> {
  const res = await runDocker(runner, [
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    image,
  ]).catch(() => null);
  if (!res || res.code !== 0) return null;
  return res.stdout.trim() || null;
}

/** Which slot, if any, is currently running for this site. `null` when
 * neither slot is up (first deploy, or a previous remove). */
export async function findActiveSlot(
  runner: CommandRunner,
  mode: SiteMode,
  slug: string
): Promise<Slot | null> {
  const res = await runDocker(runner, [
    'ps',
    '--filter',
    `label=${LABEL_OWNER}=true`,
    '--filter',
    `label=${LABEL_MODE}=${mode}`,
    '--filter',
    `label=${LABEL_SLUG}=${slug}`,
    '--format',
    '{{.Names}}',
  ]);
  if (res.code !== 0) return null;
  const names = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (names.includes(containerName(mode, slug, 'a'))) return 'a';
  if (names.includes(containerName(mode, slug, 'b'))) return 'b';
  return null;
}

async function resolvePublishedPort(
  runner: CommandRunner,
  name: string
): Promise<number | null> {
  const res = await runDocker(runner, ['port', name, '8080/tcp']);
  if (res.code !== 0) return null;
  // e.g. "127.0.0.1:54321\n"
  const match = res.stdout.trim().match(/:(\d+)\s*$/m);
  if (!match || !match[1]) return null;
  const port = Number(match[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

export interface BuildStagingResult {
  contextDir: string;
  /** Real filesystem path to hand `docker build -f`. */
  dockerfilePath: string;
  cleanup: () => Promise<void>;
}

/**
 * Materializes the trusted build context in a fresh temp directory:
 * `public/` holds the extracted, tar-safety-validated static assets, and
 * `Caddyfile` and `site-runtime.Dockerfile` are written from the templates
 * this package owns (embedded in the binary, or the operator's override
 * directory — see `site-templates.ts`).
 *
 * Both templates are written at the context root and tenant files only
 * ever land under `public/`, so no archive entry can shadow the build
 * instructions: a site containing its own `site-runtime.Dockerfile`
 * extracts to `public/site-runtime.Dockerfile`, which the build never
 * reads. The Dockerfile has to be a real file rather than the embedded
 * asset path because `docker build -f` is a separate process and cannot
 * read Bun's virtual filesystem.
 */
export async function buildDockerContext(
  tarballPath: string,
  templates: SiteRuntimeTemplates
): Promise<BuildStagingResult> {
  const contextDir = await mkdtemp(join(tmpdir(), 'flowstarter-docker-build-'));
  const cleanup = () => rm(contextDir, { recursive: true, force: true }).catch(() => undefined);
  try {
    await safeExtractTarball(tarballPath, join(contextDir, 'public'));
    await writeFile(join(contextDir, 'Caddyfile'), templates.caddyfile);
    const dockerfilePath = resolve(join(contextDir, DOCKERFILE_TEMPLATE_NAME));
    await writeFile(dockerfilePath, templates.dockerfile);
    return { contextDir, dockerfilePath, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

export interface DockerDeployDeps {
  runner: CommandRunner;
  isReady: ReadinessCheck;
  /** Reads the currently-published snippet for `slug`, or `null` if none. */
  readSnippet: (slug: string) => Promise<string | null>;
  /** Writes (or, given `''`, removes) the snippet for `slug`. */
  writeSnippet: (slug: string, snippet: string) => Promise<void>;
  reloadCaddy: () => Promise<{ ok: boolean; stderr: string }>;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

export interface DockerDeployRequest {
  slug: string;
  mode: SiteMode;
  tarballPath: string;
  sha256: string;
  /** Builds the full Caddy snippet given the chosen loopback upstream. */
  buildSnippet: (upstream: string) => string;
  /** Dockerfile and Caddyfile to build the site image from. */
  templates: SiteRuntimeTemplates;
}

export type DockerDeployOutcome =
  | { ok: true; port: number; containerName: string; imageName: string }
  | { ok: false; error: string };

async function waitForReady(
  isReady: ReadinessCheck,
  url: string,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isReady(url)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Builds the image, starts it in the slot the site is not currently
 * running in, waits for it to answer HTTP locally, then hands the caller a
 * `buildSnippet`-produced snippet to publish. Caddy is reloaded by the
 * caller (via `reloadCaddy`); on reload failure the previous snippet is
 * restored and the just-started container is torn down, leaving the
 * previously-active container as the only one serving. On success the
 * previously-active container (if any) is retired.
 */
export async function deployDockerSite(
  req: DockerDeployRequest,
  deps: DockerDeployDeps
): Promise<DockerDeployOutcome> {
  const { slug, mode, tarballPath, sha256 } = req;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 10_000;
  const readyIntervalMs = deps.readyIntervalMs ?? 250;

  let staging: BuildStagingResult;
  try {
    staging = await buildDockerContext(tarballPath, req.templates);
  } catch (e) {
    return { ok: false, error: `build context failed: ${e instanceof Error ? e.message : 'unknown'}` };
  }

  const activeSlot = await findActiveSlot(deps.runner, mode, slug);
  const targetSlot = activeSlot ? otherSlot(activeSlot) : 'a';
  const name = containerName(mode, slug, targetSlot);
  const image = imageName(mode, slug, sha256);

  // The image the currently-serving container runs. Redeploying an
  // unchanged artifact resolves `image` to exactly this ID, so every
  // cleanup path below has to be told not to delete it.
  const liveFacts = activeSlot
    ? await inspectContainer(deps.runner, mode, slug, containerName(mode, slug, activeSlot))
    : null;
  const liveImageId = liveFacts?.imageId ?? null;

  /** Undo a container this deploy started, sparing the live image. */
  const rollbackNewContainer = async (): Promise<void> => {
    await removeOwnedContainer(deps.runner, mode, slug, name);
    await removeImageUnlessProtected(deps.runner, image, [liveImageId]);
  };

  try {
    const build = await runDocker(deps.runner, [
      'build',
      ...ownershipLabelArgs(mode, slug),
      '-f',
      staging.dockerfilePath,
      '-t',
      image,
      staging.contextDir,
    ]);
    if (build.code !== 0) {
      return { ok: false, error: `docker build failed: ${build.stderr || build.stdout}` };
    }

    // Clear out a stale container left in this slot by a previous failed
    // attempt before reusing the name — but only if it is one of ours. A
    // name collision with somebody else's container fails the deploy; the
    // previous slot keeps serving and nothing is destroyed.
    const stale = await removeOwnedContainer(deps.runner, mode, slug, name);
    if (stale.conflicted) {
      return {
        ok: false,
        error: `container name ${name} is taken by a container this agent does not own`,
      };
    }

    const run = await runDocker(deps.runner, [
      'run',
      '-d',
      '--name',
      name,
      ...ownershipLabelArgs(mode, slug),
      '--label',
      `${LABEL_SLOT}=${targetSlot}`,
      // A site has to come back by itself after a host reboot or a docker
      // daemon restart. `unless-stopped` and not `always` so that a
      // container this agent deliberately stopped stays stopped.
      '--restart',
      'unless-stopped',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '64',
      '--memory',
      '64m',
      '--tmpfs',
      '/data:uid=10001,gid=10001,mode=0700,size=1m',
      '--tmpfs',
      '/config:uid=10001,gid=10001,mode=0700,size=1m',
      '-p',
      '127.0.0.1::8080',
      image,
    ]);
    if (run.code !== 0) {
      await rollbackNewContainer();
      return { ok: false, error: `docker run failed: ${run.stderr || run.stdout}` };
    }

    const port = await resolvePublishedPort(deps.runner, name);
    if (port == null) {
      await rollbackNewContainer();
      return { ok: false, error: 'could not resolve the published loopback port' };
    }

    const ready = await waitForReady(
      deps.isReady,
      `http://127.0.0.1:${port}/`,
      readyTimeoutMs,
      readyIntervalMs
    );
    if (!ready) {
      await rollbackNewContainer();
      return { ok: false, error: 'container did not become ready before the timeout' };
    }

    // From here on the container is running and the snippet is about to
    // change, so every step is inside a catch: an exception thrown by
    // `writeSnippet` (a read-only /etc/caddy, a full disk) used to escape
    // this function and leave the container it had just started orphaned
    // and unreferenced, forever.
    const previousSnippet = await deps.readSnippet(slug).catch(() => null);
    try {
      const newSnippet = req.buildSnippet(`127.0.0.1:${port}`);
      await deps.writeSnippet(slug, newSnippet);
      const reload = await deps.reloadCaddy();
      if (!reload.ok) {
        await restorePreviousSnippet(deps, slug, previousSnippet);
        await rollbackNewContainer();
        return { ok: false, error: `caddy reload failed: ${reload.stderr}` };
      }
    } catch (e) {
      await restorePreviousSnippet(deps, slug, previousSnippet);
      await rollbackNewContainer();
      return {
        ok: false,
        error: `caddy snippet cutover failed: ${e instanceof Error ? e.message : 'unknown'}`,
      };
    }

    // Cutover succeeded. Retire the slot that was serving until now,
    // keeping its image when the new container shares it.
    if (activeSlot) {
      const previousName = containerName(mode, slug, activeSlot);
      const retired = await removeOwnedContainer(deps.runner, mode, slug, previousName);
      if (retired.removed) {
        const newImageId = await inspectContainer(deps.runner, mode, slug, name).then(
          (facts) => facts?.imageId ?? null,
          () => null
        );
        await removeImageUnlessProtected(deps.runner, retired.imageId, [newImageId]);
      }
    }

    return { ok: true, port, containerName: name, imageName: image };
  } finally {
    await staging.cleanup();
  }
}

/**
 * Puts back whatever snippet was published before this deploy and reloads.
 * Both steps swallow their errors on purpose: this runs while unwinding a
 * deploy that has already failed, and the caller must still get the
 * original failure rather than a second one from the rollback.
 */
async function restorePreviousSnippet(
  deps: DockerDeployDeps,
  slug: string,
  previousSnippet: string | null
): Promise<void> {
  await deps.writeSnippet(slug, previousSnippet ?? '').catch(() => undefined);
  await deps.reloadCaddy().catch(() => undefined);
}

/** Stops and removes every container and image this agent owns for
 * `(mode, slug)` — the Docker-mode counterpart of `rm -rf siteDir` in
 * filesystem mode. Filters are scoped to our own ownership labels plus
 * this slug, so a resource this agent did not create is never touched. */
export async function removeDockerSite(
  runner: CommandRunner,
  mode: SiteMode,
  slug: string
): Promise<void> {
  const containers = await runDocker(runner, [
    'ps',
    '-a',
    '--filter',
    `label=${LABEL_OWNER}=true`,
    '--filter',
    `label=${LABEL_MODE}=${mode}`,
    '--filter',
    `label=${LABEL_SLUG}=${slug}`,
    '--format',
    '{{.ID}}',
  ]);
  const containerIds =
    containers.code === 0
      ? containers.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
  for (const id of containerIds) {
    await runDocker(runner, ['rm', '-f', id]).catch(() => undefined);
  }

  const images = await runDocker(runner, [
    'images',
    '--filter',
    `label=${LABEL_OWNER}=true`,
    '--filter',
    `label=${LABEL_MODE}=${mode}`,
    '--filter',
    `label=${LABEL_SLUG}=${slug}`,
    '--format',
    '{{.ID}}',
  ]);
  const imageIds =
    images.code === 0 ? images.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  for (const id of imageIds) {
    // Unforced, like every other `rmi` here: every container of ours is
    // already gone, so anything still holding this image is somebody
    // else's and the daemon should refuse rather than untag it.
    await runDocker(runner, ['rmi', id]).catch(() => undefined);
  }
}
