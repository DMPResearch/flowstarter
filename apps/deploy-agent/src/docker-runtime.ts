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
 * the cutover succeeds, so a failed build, a failed health check or a
 * failed Caddy reload all leave the previous container serving.
 *
 * Ports are explicit, not Docker-assigned. Each slot publishes on a host
 * port the caller derived from the slug (see `site-ports.ts`) and passes
 * in as `req.ports`, bound with `-p 127.0.0.1:<port>:8080` rather than
 * `-p 127.0.0.1::8080`. An ephemeral binding meant the port could change on
 * every container start, including a `docker restart` after a reboot,
 * which is exactly the incident stable ports exist to prevent: a healthy
 * container whose Caddy snippet points at a port nothing is listening on
 * anymore. `reconcileDockerSites`, below, is the safety net for whatever
 * this still misses (a hand-run container, a snippet edited by hand).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { safeExtractTarball } from './tar-safety';
import { DOCKERFILE_TEMPLATE_NAME, type SiteRuntimeTemplates } from './site-templates';
import type { PortState, SitePortPair } from './site-ports';

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
  /**
   * The stable host ports for this slug's two blue/green slots, from the
   * ports state file (`site-ports.ts`). Whichever slot this deploy targets
   * publishes on its half of the pair, explicitly, every time, so the
   * port a redeploy or a container restart ends up on is never a surprise.
   */
  ports: SitePortPair;
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
  // Stable for this slot's lifetime, from the ports state file, not
  // whatever Docker feels like handing out this time.
  const port = targetSlot === 'a' ? req.ports.a : req.ports.b;

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
      `127.0.0.1:${port}:8080`,
      image,
    ]);
    if (run.code !== 0) {
      await rollbackNewContainer();
      return { ok: false, error: `docker run failed: ${run.stderr || run.stdout}` };
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

/**
 * Reconciliation: the safety net for the class of incident stable ports
 * exist to prevent. Even with an explicit `-p 127.0.0.1:<port>:8080`
 * binding, a container recreated by hand, or one still running the old
 * ephemeral-port scheme from before this agent carried the fix, can end up
 * serving on a port its Caddy snippet does not name. This walks every site
 * the agent owns, asks Docker what port its actually-running container
 * answers on, and repairs the snippet when it disagrees, without ever
 * deleting a route for a container that is not actually healthy.
 */

const PROXY_PORT_PATTERN = /reverse_proxy\s+127\.0\.0\.1:(\d+)/;

/**
 * The port a docker-mode snippet's `reverse_proxy 127.0.0.1:<port>` line
 * names, or null if the snippet has no such line. The editor route proxies
 * to a named host, never to a loopback port, so it never matches this.
 */
export function extractProxyPort(snippet: string): number | null {
  const match = snippet.match(PROXY_PORT_PATTERN);
  if (!match || !match[1]) return null;
  const port = Number(match[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * Replaces every loopback `reverse_proxy` target's port with `newPort`,
 * leaving the rest of the snippet (hostnames, the editor route, headers)
 * byte-for-byte as it was.
 */
export function rewriteProxyPort(snippet: string, newPort: number): string {
  return snippet.replace(/(reverse_proxy\s+127\.0\.0\.1:)\d+/g, `$1${newPort}`);
}

/**
 * `fs-deploy-<mode>-<slug>-<slot>` parsed back into its parts, or null for
 * a name that does not have this agent's shape. Defensive: every name this
 * is called on already passed our own ownership label filter, but a stray
 * container sharing the label by accident should not crash reconcile.
 */
function parseOwnedContainerName(
  mode: SiteMode,
  name: string,
): { slug: string; slot: Slot } | null {
  const prefix = `${NAMESPACE}-${mode}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const slotMark = rest.slice(-2);
  if (slotMark !== '-a' && slotMark !== '-b') return null;
  const slug = rest.slice(0, -2);
  return slug ? { slug, slot: slotMark === '-a' ? 'a' : 'b' } : null;
}

/** Every slug with at least one container (running or not) this agent
 * owns in `mode`, from `docker ps -a` rather than the `docker ps`
 * `findActiveSlot` uses, so a container Docker considers stopped is still
 * found and reported rather than silently skipped. */
async function listOwnedSlugs(
  runner: CommandRunner,
  mode: SiteMode,
): Promise<string[]> {
  const res = await runDocker(runner, [
    'ps',
    '-a',
    '--filter',
    `label=${LABEL_OWNER}=true`,
    '--filter',
    `label=${LABEL_MODE}=${mode}`,
    '--format',
    '{{.Names}}',
  ]);
  if (res.code !== 0) return [];
  const slugs = new Set<string>();
  for (const name of res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const parsed = parseOwnedContainerName(mode, name);
    if (parsed) slugs.add(parsed.slug);
  }
  return [...slugs];
}

export type ReconcileStatus =
  | 'ok'
  | 'repaired'
  | 'down'
  | 'missing-snippet'
  | 'error';

export interface ReconcileSiteReport {
  slug: string;
  slot: Slot | null;
  status: ReconcileStatus;
  /** The port the running container actually answers on, from `docker
   * port`. Null when there is no running container to ask. */
  actualPort: number | null;
  /** The port the current Caddy snippet names. Null when there is no
   * snippet, or it has no loopback `reverse_proxy` line. */
  snippetPort: number | null;
  /** The port recorded in the ports state file for this slot, when a
   * `portState` was given to `reconcileDockerSites`. Informational: the
   * live container, not the state file, decides what the snippet says. */
  statePort: number | null;
  message: string;
}

export interface ReconcileResult {
  checkedSlugs: number;
  repaired: string[];
  down: string[];
  errors: string[];
  sites: ReconcileSiteReport[];
  /** Whether a Caddy reload actually ran. Only true when at least one
   * snippet was rewritten. */
  reloaded: boolean;
}

export interface ReconcileDeps {
  isReady: ReadinessCheck;
  readSnippet: (slug: string) => Promise<string | null>;
  writeSnippet: (slug: string, snippet: string) => Promise<void>;
  reloadCaddy: () => Promise<{ ok: boolean; stderr: string }>;
  /** Serializes with any concurrent deploy or delete of the same slug, the
   * way `index.ts`'s slug lock does. Reconcile runs unlocked (a plain
   * pass-through) when the caller does not supply one, which is fine for
   * tests but not for the real server. */
  withSlugLock?: <T>(slug: string, fn: () => Promise<T>) => Promise<T>;
}

function defaultWithSlugLock<T>(
  _slug: string,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

interface SiteReconcileOutcome extends ReconcileSiteReport {
  previousSnippet?: string | null;
}

async function reconcileOneSite(
  runner: CommandRunner,
  mode: SiteMode,
  slug: string,
  deps: Pick<ReconcileDeps, 'isReady' | 'readSnippet' | 'writeSnippet'>,
  expectedPair: SitePortPair | undefined,
): Promise<SiteReconcileOutcome> {
  const activeSlot = await findActiveSlot(runner, mode, slug);
  if (!activeSlot) {
    return {
      slug,
      slot: null,
      status: 'down',
      actualPort: null,
      snippetPort: null,
      statePort: null,
      message: `no running container for "${slug}"; the site is down, left whatever snippet exists untouched`,
    };
  }

  const statePort = expectedPair
    ? activeSlot === 'a'
      ? expectedPair.a
      : expectedPair.b
    : null;
  const name = containerName(mode, slug, activeSlot);
  const actualPort = await resolvePublishedPort(runner, name);
  if (actualPort == null) {
    return {
      slug,
      slot: activeSlot,
      status: 'error',
      actualPort: null,
      snippetPort: null,
      statePort,
      message: `container ${name} is running but reports no published port`,
    };
  }

  const healthy = await deps.isReady(`http://127.0.0.1:${actualPort}/`);
  if (!healthy) {
    return {
      slug,
      slot: activeSlot,
      status: 'down',
      actualPort,
      snippetPort: null,
      statePort,
      message: `container ${name} on port ${actualPort} is not answering; left its route untouched rather than reroute to a container that is not serving`,
    };
  }

  const snippet = await deps.readSnippet(slug);
  if (snippet == null) {
    return {
      slug,
      slot: activeSlot,
      status: 'missing-snippet',
      actualPort,
      snippetPort: null,
      statePort,
      message: `container ${name} is healthy on port ${actualPort} but has no Caddy snippet; needs a real redeploy, reconcile cannot invent its hostnames`,
    };
  }

  const snippetPort = extractProxyPort(snippet);
  const stateNote =
    statePort != null && statePort !== actualPort
      ? ` (the ports state file also disagrees, it names ${statePort})`
      : '';

  if (snippetPort === actualPort) {
    return {
      slug,
      slot: activeSlot,
      status: 'ok',
      actualPort,
      snippetPort,
      statePort,
      message: `snippet already matches the running container${stateNote}`,
    };
  }

  const rewritten = rewriteProxyPort(snippet, actualPort);
  await deps.writeSnippet(slug, rewritten);
  return {
    slug,
    slot: activeSlot,
    status: 'repaired',
    actualPort,
    snippetPort,
    statePort,
    previousSnippet: snippet,
    message:
      `snippet pointed at ${snippetPort ?? 'no port'}, container ${name} is really on ` +
      `${actualPort}; rewrote the route${stateNote}`,
  };
}

/**
 * Walks every site this agent owns, checks its live container against its
 * Caddy snippet, and repairs any snippet that has drifted. One Caddy
 * reload for the whole pass, not one per site: if that reload fails, every
 * snippet this pass touched is put back exactly as it was, because a
 * half-applied set of route changes that never actually reached Caddy is
 * worse than the drift this was trying to fix.
 *
 * `portState`, when given, is consulted for its recorded port per slot and
 * folded into the report and log line. Informational only: the live
 * container is always the port of record for what Caddy is told to proxy
 * to.
 */
export async function reconcileDockerSites(
  runner: CommandRunner,
  mode: SiteMode,
  deps: ReconcileDeps,
  portState: PortState | null = null,
): Promise<ReconcileResult> {
  const withLock = deps.withSlugLock ?? defaultWithSlugLock;
  const slugs = await listOwnedSlugs(runner, mode);
  const outcomes: SiteReconcileOutcome[] = [];

  for (const slug of slugs) {
    const expectedPair = portState?.sites[slug];
    const outcome = await withLock(slug, () =>
      reconcileOneSite(runner, mode, slug, deps, expectedPair),
    );
    outcomes.push(outcome);
  }

  const repairedOutcomes = outcomes.filter((o) => o.status === 'repaired');
  let reloaded = false;

  if (repairedOutcomes.length > 0) {
    const reload = await deps
      .reloadCaddy()
      .catch((e) => ({
        ok: false,
        stderr: e instanceof Error ? e.message : 'unknown error',
      }));
    if (reload.ok) {
      reloaded = true;
    } else {
      // Caddy never picked up any of this pass's rewrites, so put every one
      // of them back rather than leave `.caddy` files on disk that disagree
      // with what is actually being served.
      for (const outcome of repairedOutcomes) {
        await withLock(outcome.slug, () =>
          deps
            .writeSnippet(outcome.slug, outcome.previousSnippet ?? '')
            .catch(() => undefined),
        );
      }
      await deps.reloadCaddy().catch(() => undefined);
      for (const outcome of repairedOutcomes) {
        outcome.status = 'error';
        outcome.message = `rewrite reverted: caddy reload failed (${reload.stderr})`;
      }
    }
  }

  return {
    checkedSlugs: slugs.length,
    repaired: outcomes
      .filter((o) => o.status === 'repaired')
      .map((o) => o.slug),
    down: outcomes.filter((o) => o.status === 'down').map((o) => o.slug),
    errors: outcomes
      .filter((o) => o.status === 'error' || o.status === 'missing-snippet')
      .map((o) => o.slug),
    sites: outcomes.map(
      ({ previousSnippet: _previousSnippet, ...rest }) => rest,
    ),
    reloaded,
  };
}
