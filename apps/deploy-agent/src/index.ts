/**
 * Flowstarter deploy-agent.
 *
 * Tiny Bun HTTP service that runs on each Hetzner Caddy host. Owned by
 * the host, called by flowstarter-main (or the operator service).
 *
 * Endpoints:
 *   POST   /sites/:slug/deploy      → fetch artifact, extract, write Caddy snippet, reload
 *   DELETE /sites/:slug              → remove site dir + Caddy snippet, reload
 *   GET    /health                   → liveness
 *
 * Auth: `Authorization: Bearer <DEPLOY_AGENT_SHARED_SECRET>` on all endpoints.
 *
 * Bootstrap: cloud-init drops a systemd unit pointing here.
 *
 * Idempotency: redeploys overwrite the same site dir + snippet. The agent
 * stages each artifact in a temp dir then atomically renames into place
 * so a partial download can't corrupt a live site.
 */

import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { resolvePlatformDomain } from '@flowstarter/platform-config';
import { safeExtractTarball } from './tar-safety';
import {
  buildCaddySnippet,
  buildPreviewCaddySnippet,
  type ServeTarget,
} from './caddy-snippet';
import {
  SLUG_PLACEHOLDER,
  hostFromTemplate,
  slugFromTemplateHost,
} from './host-templates';
import {
  deployDockerSite,
  removeDockerSite,
  reconcileDockerSites,
  systemCommandRunner,
  httpReadinessCheck,
  type ReconcileResult,
} from './docker-runtime';
import {
  loadSiteRuntimeTemplates,
  type SiteRuntimeTemplates,
} from './site-templates';
import {
  parsePortRange,
  loadPortState,
  savePortState,
  assignSitePorts,
  releaseSitePorts,
  type PortRange,
} from './site-ports';

const PORT = Number(process.env.DEPLOY_AGENT_PORT ?? 8443);

/**
 * Which interface to listen on. `0.0.0.0` stays the default: the paid-site
 * agent on a Hetzner box is reached by flowstarter-main over the public
 * address, with the firewall deciding who may connect.
 *
 * Set it to `127.0.0.1` for a host whose agent is meant to be private —
 * reached only through an SSH tunnel, which is what
 * `FLOWSTARTER_EXISTING_HOST_AGENT_URL` allows loopback HTTP for. Binding
 * to loopback makes that a property of the socket rather than of a
 * firewall rule somebody has to remember to write.
 */
const BIND_ADDRESS = process.env.DEPLOY_AGENT_BIND_ADDRESS?.trim() || '0.0.0.0';
const SHARED_SECRET = process.env.DEPLOY_AGENT_SHARED_SECRET ?? '';
const SITES_ROOT = process.env.DEPLOY_AGENT_SITES_ROOT ?? '/var/www/sites';
const CADDY_SITES_DIR =
  process.env.DEPLOY_AGENT_CADDY_SITES_DIR ?? '/etc/caddy/sites';
const CADDY_RELOAD_CMD =
  process.env.DEPLOY_AGENT_CADDY_RELOAD_CMD ?? 'systemctl reload caddy';
const TEMP_ROOT =
  process.env.DEPLOY_AGENT_TEMP_ROOT ?? '/tmp/flowstarter-deploys';
/**
 * Bumped for the `/health` change: it is authenticated now and carries
 * `siteRuntime`. An operator rolling the fleet needs to be able to tell,
 * from the response, which binary a host is running.
 */
const VERSION = '0.3.0';

/**
 * Which fleet this instance serves.
 *
 * `sites` (the default, and what every existing host runs) is the paid-site
 * agent: /var/www/sites, /etc/caddy/sites, port 8443, the editor reverse-proxy
 * in every snippet, `systemctl reload caddy`. Its behaviour is unchanged.
 *
 * `previews` is a SECOND instance of this same binary, started by a second
 * systemd unit from a second env file, serving anonymous funnel previews. It
 * writes to a different sites root and a different Caddy config directory,
 * loaded by a different Caddy process — so a snippet generated from an
 * LLM-authored preview that fails to parse takes down previews and leaves
 * every paying customer on the same box serving. Its snippets also carry
 * `X-Robots-Tag: noindex` and no editor proxy: a preview is a temporary
 * marketing artefact, not a workspace somebody edits.
 *
 * Everything that differs between the two comes from env. There is no code
 * path in which a previews-configured agent writes into /var/www/sites.
 */
const MODE =
  process.env.DEPLOY_AGENT_MODE === 'previews' ? 'previews' : 'sites';

/**
 * `filesystem` (default) is the behaviour above: extract into
 * `SITES_ROOT/{slug}` and let Caddy serve that directory. `docker` builds a
 * pinned Caddy image around the same validated static assets and runs it
 * in its own container, reached over a loopback port the snippet
 * reverse-proxies to. Opt-in: every existing host keeps running
 * filesystem mode with no config change.
 */
const SITE_RUNTIME =
  process.env.DEPLOY_AGENT_SITE_RUNTIME === 'docker' ? 'docker' : 'filesystem';

const DOCKER_READY_TIMEOUT_MS = Number(
  process.env.DEPLOY_AGENT_DOCKER_READY_TIMEOUT_MS ?? 10_000,
);
const DOCKER_READY_INTERVAL_MS = Number(
  process.env.DEPLOY_AGENT_DOCKER_READY_INTERVAL_MS ?? 250,
);

/**
 * Bounds on fetching an artifact from a caller-supplied URL.
 *
 * This is a generated site's tarball, but the URL that points at it is not
 * trusted the way the bytes are checked to be (that is `tar-safety.ts`'s
 * job): nothing here stops a caller — or a compromised/spoofed origin behind
 * a signed URL — from serving an enormous or slow response, or a redirect
 * onto a host nobody meant to hand this bearer-authenticated fetch to.
 */
const MAX_ARTIFACT_DOWNLOAD_BYTES = Number(
  process.env.DEPLOY_AGENT_MAX_ARTIFACT_BYTES ?? 256 * 1024 * 1024,
);
const ARTIFACT_FETCH_TIMEOUT_MS = Number(
  process.env.DEPLOY_AGENT_ARTIFACT_FETCH_TIMEOUT_MS ?? 30_000,
);
/** A hex sha256 digest: exactly what `assertUsableArtifactUrl`'s caller and
 * `packSiteTarball` producers always compute. Anything else is rejected
 * before a byte is fetched. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * The range a site's stable host port is hashed into (see `site-ports.ts`).
 * `20000-29999` by default: well above the well-known ports and Caddy's own
 * 80/443/9080, well below the ephemeral range the kernel hands out on its
 * own, so a deterministic site port never collides with one either side
 * assigns for something else.
 */
const SITE_PORT_RANGE: PortRange = parsePortRange(
  process.env.DEPLOY_AGENT_SITE_PORT_RANGE,
);

/**
 * Where each slug's stable port pair is recorded, so it survives an agent
 * restart. Defaults to `.ports.json` inside `SITES_ROOT`, the same root the
 * filesystem runtime extracts sites into, docker mode or not, so an
 * operator inspecting one host directory finds both.
 */
const PORTS_STATE_FILE =
  process.env.DEPLOY_AGENT_PORTS_STATE_FILE?.trim() ||
  join(SITES_ROOT, '.ports.json');

/**
 * How often the agent re-checks every owned container's published port
 * against its Caddy snippet, on top of running the same check once at
 * startup. `0` (or negative) disables the interval; startup reconciliation
 * still runs. Five minutes by default: cheap enough to run unconditionally
 * and short enough that a `docker restart` run by hand does not leave a
 * site behind a stale route for long.
 */
const RECONCILE_INTERVAL_MS = Number(
  process.env.DEPLOY_AGENT_RECONCILE_INTERVAL_MS ?? 5 * 60 * 1000,
);

/**
 * Port the previews Caddy listens on. TLS for the preview zone is terminated
 * by the front Caddy, which proxies here over loopback, so preview snippets
 * are plain `http://host:port` blocks.
 */
const SITE_PORT = Number(process.env.DEPLOY_AGENT_SITE_PORT ?? 9080);

/**
 * The zone preview hostnames must end in. Guards the TLS ask endpoint.
 *
 * Same env-driven rule as `previewDomainForSlug` and `PREVIEW_DOMAIN_SUFFIX`
 * in flowstarter-main: `resolvePlatformDomain()` reads this process's own
 * `FLOWSTARTER_ENV` / `NODE_ENV`, so a host bootstrapped for development or
 * staging defaults to `preview.flowstarter.dev` and one bootstrapped for
 * production defaults to `preview.flowstarter.net`, so an operator never has
 * to set `DEPLOY_AGENT_PREVIEW_HOST_SUFFIX` by hand per environment.
 */
const PREVIEW_HOST_SUFFIX =
  process.env.DEPLOY_AGENT_PREVIEW_HOST_SUFFIX?.trim() ||
  `preview.${resolvePlatformDomain()}`;

/**
 * The FINAL hostname a paid site is served at: `{slug}.{domain}`.
 *
 * A paid site is not a preview and does not live in the preview namespace.
 * Before this existed, the only template a sites-mode agent understood was
 * `DEPLOY_AGENT_PREVIEW_DOMAIN_TEMPLATE`, so a client who had paid got a site
 * whose one working hostname had the word "preview" in it — and an operator
 * who left that unset got an empty Caddy snippet and a site nobody could
 * reach at all. The preview template still works, and still means what it
 * meant; this is the one that means "this site is theirs".
 *
 * Defaults the same env-driven way `PREVIEW_HOST_SUFFIX` does, so a host
 * bootstrapped for production serves `{slug}.flowstarter.net` and one
 * bootstrapped for development serves `{slug}.flowstarter.dev` without an
 * operator having to remember a variable.
 */
const SITE_DOMAIN_TEMPLATE =
  process.env.DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE?.trim() ||
  `{slug}.${resolvePlatformDomain()}`;

const PREVIEW_DOMAIN_TEMPLATE =
  process.env.DEPLOY_AGENT_PREVIEW_DOMAIN_TEMPLATE?.trim() || null;

if (!SHARED_SECRET) {
  console.error(
    '[deploy-agent] DEPLOY_AGENT_SHARED_SECRET is not set. Refusing to start.',
  );
  process.exit(1);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

interface DeployBody {
  /** Empty when the caller streamed the tarball instead of naming a URL. */
  artifact_url: string;
  artifact_sha256?: string | null;
  primary_domain?: string | null;
  additional_domains?: string[];
  /** Set when the artifact arrived as `application/octet-stream`. */
  artifact_bytes?: Uint8Array | null;
}

/**
 * Optional plain-HTTP static server for the extracted sites, keyed by path:
 * `http://<host>:<port>/<slug>/…` serves `<SITES_ROOT>/<slug>/…`.
 *
 * A real host does not need this — Caddy serves the same directories by
 * hostname with TLS, which is what the snippets this agent writes configure.
 * A laptop has no wildcard DNS, no certificate and (in dev) a Caddy reload
 * that is `echo reloaded`, so without this the deploy chain ends at "the files
 * are on disk somewhere" and nobody can open the site. Off unless
 * DEPLOY_AGENT_STATIC_PORT is set.
 */
const STATIC_PORT = process.env.DEPLOY_AGENT_STATIC_PORT
  ? Number(process.env.DEPLOY_AGENT_STATIC_PORT)
  : null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SECRET_DIGEST = createHash('sha256').update(SHARED_SECRET).digest();

/**
 * Compares SHA-256 digests rather than the tokens themselves. Two digests
 * are always the same length, so there is no early return on a length
 * mismatch for a caller to time the secret's length out of, and
 * `timingSafeEqual` handles the rest.
 */
function authorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  const digest = createHash('sha256').update(token).digest();
  return timingSafeEqual(digest, SECRET_DIGEST);
}

/**
 * Serializes everything that mutates one slug's containers, site directory
 * and Caddy snippet.
 *
 * Two concurrent deploys of the same slug both read `findActiveSlot`, both
 * pick the same free slot, and the second `docker run --name` loses on the
 * name — after which its failure cleanup deletes the container the first
 * one is mid-cutover to. A deploy racing a delete is worse: the delete can
 * land between the readiness check and the snippet write, leaving a
 * snippet pointing at a container that has just been removed. Per-slug and
 * not global, so one slow site's build never blocks another's.
 */
const slugLocks = new Map<string, Promise<unknown>>();

function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const previous = slugLocks.get(slug) ?? Promise.resolve();
  // `then(fn, fn)` — the next request runs whether the previous one
  // resolved or threw. A failed deploy must not wedge the slug.
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  slugLocks.set(slug, tail);
  void tail.then(() => {
    if (slugLocks.get(slug) === tail) slugLocks.delete(slug);
  });
  return run;
}

/**
 * Serializes every read-modify-write of the ports state file. Two deploys
 * of different slugs racing this without a lock could each load the file
 * before the other's write landed, and one assignment would silently
 * disappear on save, the exact hazard `withSlugLock` exists for on a
 * per-slug basis. This one is global because the file is shared across
 * every slug.
 */
let portsFileLock: Promise<unknown> = Promise.resolve();

function withPortsFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = portsFileLock.then(fn, fn);
  portsFileLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The stable `{a, b}` port pair for `slug`, assigning and persisting one
 * if this is the slug's first deploy. Stable for the site's lifetime after
 * that: see `assignSitePorts` in `site-ports.ts`. */
async function assignPortsForSlug(
  slug: string,
): Promise<{ a: number; b: number }> {
  return withPortsFileLock(async () => {
    const state = await loadPortState(PORTS_STATE_FILE);
    const pair = assignSitePorts(state, slug, SITE_PORT_RANGE);
    await savePortState(PORTS_STATE_FILE, state);
    return pair;
  });
}

/** Frees `slug`'s port pair so a future slug's hash can land on it. Called
 * from `handleRemove`; best-effort the same way the rest of delete is. */
async function releasePortsForSlug(slug: string): Promise<void> {
  return withPortsFileLock(async () => {
    const state = await loadPortState(PORTS_STATE_FILE);
    releaseSitePorts(state, slug);
    await savePortState(PORTS_STATE_FILE, state);
  });
}

/**
 * Templates are read once and cached, but only on success — a failed load
 * leaves the cache empty so an operator who fixes
 * `DEPLOY_AGENT_DOCKER_TEMPLATE_DIR` does not have to restart the agent.
 */
let templatesCache: Promise<SiteRuntimeTemplates> | null = null;

function siteRuntimeTemplates(): Promise<SiteRuntimeTemplates> {
  if (!templatesCache) {
    templatesCache = loadSiteRuntimeTemplates().catch((e) => {
      templatesCache = null;
      throw e;
    });
  }
  return templatesCache;
}

function siteSlugFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/sites\/([^/]+)(?:\/.*)?$/);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

async function shellOk(cmd: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolveSpawn) => {
    const child = spawn('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) =>
      resolveSpawn({ ok: code === 0, stderr: stderr.trim() }),
    );
  });
}

/**
 * Reverse-proxy upstream for the multitenant editor container. Each
 * Hetzner host runs ONE editor container; every site's Caddy snippet
 * sends `/editor*` requests there. Defaults to `http://editor:3773`
 * which matches the docker-compose service name; override via env when
 * the editor lives at a different address (e.g. systemd unit on
 * 127.0.0.1).
 */
const EDITOR_UPSTREAM =
  process.env.DEPLOY_AGENT_EDITOR_UPSTREAM ?? 'http://editor:3773';

function siteServeTarget(rootDir: string): ServeTarget {
  return { kind: 'static', rootDir };
}

function dockerServeTarget(upstream: string): ServeTarget {
  return { kind: 'proxy', upstream };
}

/**
 * Does this agent currently serve `domain`?
 *
 * The front Caddy calls this before issuing an on-demand certificate. Answers
 * 200 only for a hostname one of this agent's own templates produces AND that
 * has a snippet on disk. It used to be a previews-only endpoint, which made
 * on-demand TLS impossible for a paid site's final hostname: the sites agent
 * 404'd for every name including its own.
 */
async function handleTlsAsk(domain: string | null): Promise<Response> {
  const host = (domain ?? '').trim().toLowerCase();

  // Which slug, if any, this agent would serve this hostname for. A previews
  // agent answers for its preview zone; a sites agent answers for the final
  // site names its own template mints, and for a preview name only if it has
  // been configured to serve one. An agent with no matching template answers
  // for nothing, which is the correct answer and the safe one.
  const slug =
    MODE === 'previews'
      ? slugFromTemplateHost(`${SLUG_PLACEHOLDER}.${PREVIEW_HOST_SUFFIX}`, host)
      : (slugFromTemplateHost(SITE_DOMAIN_TEMPLATE, host) ??
        slugFromTemplateHost(PREVIEW_DOMAIN_TEMPLATE, host));

  if (!slug) {
    return jsonResponse({ error: 'not a host served here' }, 404);
  }
  // Having a name is not enough: there has to be a site behind it. Otherwise
  // anyone who points a record at this box gets us to ask Let's Encrypt for a
  // certificate on their behalf, which is both a rate-limit hazard and an open
  // cert-minting service.
  const snippet = join(CADDY_SITES_DIR, `${slug}.caddy`);
  if (!(await exists(snippet))) {
    return jsonResponse({ error: 'no such site' }, 404);
  }
  return new Response('', { status: 200 });
}

async function ensureDirs(): Promise<void> {
  for (const d of [SITES_ROOT, CADDY_SITES_DIR, TEMP_ROOT]) {
    await mkdir(d, { recursive: true });
  }
}

/**
 * `fetch`, but refusing to hop to a different host on a redirect.
 *
 * The default `redirect: 'follow'` would let an origin we were told to trust
 * for one host silently hand the download to a different one — including one
 * this agent's network position lets it reach but the caller never intended
 * (an internal address, a different tenant's bucket, anything). Each hop is
 * checked by hand instead: same scheme-and-host as the URL we were actually
 * given, up to a small, fixed number of redirects.
 */
async function fetchSameHost(
  url: URL,
  init: RequestInit,
  maxRedirects = 5,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400 || !res.headers.has('location')) {
      return res;
    }
    if (hop >= maxRedirects) {
      throw new Error('artifact fetch failed: too many redirects');
    }
    const location = new URL(res.headers.get('location')!, current);
    if (location.host !== url.host) {
      throw new Error('artifact fetch failed: redirected to a different host');
    }
    current = location;
  }
}

/**
 * Reads `res.body` up to `maxBytes`, aborting the underlying request the
 * moment the limit is crossed rather than buffering an unbounded response
 * first and checking afterwards — a `content-length` header is an origin's
 * claim, not a guarantee, so the enforcement has to happen on the bytes that
 * actually arrive.
 */
async function readBounded(
  res: Response,
  maxBytes: number,
  abort: () => void,
): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error('artifact exceeds the configured size limit');
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error('artifact exceeds the configured size limit');
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort();
      throw new Error('artifact exceeds the configured size limit');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchAndVerify(
  url: string,
  expectedSha256: string,
): Promise<{ tarballPath: string; actualSha256: string; sizeBytes: number }> {
  // Never reached with an empty/malformed digest — `handleDeploy` validates
  // this before calling in here — but a defensive check costs nothing and
  // means this function's contract does not depend on a caller remembering.
  if (!SHA256_HEX.test(expectedSha256)) {
    throw new Error('artifact_sha256 must be a 64-character hex sha256');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL itself may be a signed, capability-bearing link — never echo
    // it back in an error a caller (or their logs) will see.
    throw new Error('artifact fetch failed: invalid URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ARTIFACT_FETCH_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetchSameHost(parsed, {
      headers: { 'User-Agent': `flowstarter-deploy-agent/${VERSION}` },
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('artifact fetch timed out');
    }
    // Rethrow our own redirect/host errors verbatim; wrap anything else
    // (network errors from `fetch` itself often carry the URL in `cause`).
    if (e instanceof Error && e.message.startsWith('artifact fetch failed')) {
      throw e;
    }
    throw new Error('artifact fetch failed: could not reach the origin');
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`artifact fetch failed: origin returned ${res.status}`);
  }

  const buf = await readBounded(res, MAX_ARTIFACT_DOWNLOAD_BYTES, () =>
    controller.abort(),
  );
  const hash = createHash('sha256').update(buf).digest('hex');
  if (expectedSha256.toLowerCase() !== hash) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${hash}`);
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tarballPath = join(TEMP_ROOT, `${stamp}.tar.gz`);
  await writeFile(tarballPath, buf);
  return { tarballPath, actualSha256: hash, sizeBytes: buf.length };
}

async function extractTarball(
  tarballPath: string,
  destDir: string,
): Promise<void> {
  // Extract into a fresh staging dir, validating every entry first (see
  // tar-safety.ts), then rename to destDir atomically.
  const stagingDir = `${destDir}.staging-${Date.now()}`;
  try {
    await safeExtractTarball(tarballPath, stagingDir);
  } catch (e) {
    await rm(stagingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw new Error(
      `tar extract failed: ${e instanceof Error ? e.message : 'unknown'}`,
    );
  }

  // Atomically replace destDir with stagingDir.
  const backupDir = (await exists(destDir))
    ? `${destDir}.backup-${Date.now()}`
    : null;
  if (backupDir) {
    await rename(destDir, backupDir);
  }
  await rename(stagingDir, destDir);
  if (backupDir) {
    // Best-effort cleanup of the previous version.
    await rm(backupDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeCaddySnippet(slug: string, snippet: string): Promise<void> {
  const file = join(CADDY_SITES_DIR, `${slug}.caddy`);
  if (snippet.length === 0) {
    if (await exists(file)) await rm(file, { force: true });
    return;
  }
  const tmp = `${file}.tmp`;
  await writeFile(tmp, snippet, { mode: 0o644 });
  await rename(tmp, file);
}

async function reloadCaddy(): Promise<{ ok: boolean; stderr: string }> {
  return shellOk(CADDY_RELOAD_CMD);
}

async function readCaddySnippet(slug: string): Promise<string | null> {
  const file = join(CADDY_SITES_DIR, `${slug}.caddy`);
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Runs one reconciliation pass: every owned container's actual published
 * port against its Caddy snippet, repairing whatever has drifted. Called
 * at startup, on the reconcile interval, and from `POST /reconcile`, so
 * all three log the same way and none of them can throw past this into an
 * unhandled rejection or a 500 with no body.
 *
 * A no-op returning `null` in filesystem mode: there are no containers to
 * ask, and no port for a snippet to drift from.
 */
export async function runReconcile(
  trigger: string,
): Promise<ReconcileResult | null> {
  if (SITE_RUNTIME !== 'docker') return null;
  try {
    const portState = await loadPortState(PORTS_STATE_FILE);
    const result = await reconcileDockerSites(
      systemCommandRunner,
      MODE,
      {
        isReady: httpReadinessCheck,
        readSnippet: readCaddySnippet,
        writeSnippet: writeCaddySnippet,
        reloadCaddy,
        withSlugLock,
      },
      portState,
    );
    if (result.repaired.length > 0) {
      console.info(
        `[deploy-agent] reconcile (${trigger}) rewrote a stale route for: ${result.repaired.join(', ')}`,
      );
    }
    if (result.down.length > 0) {
      console.error(
        `[deploy-agent] reconcile (${trigger}) found no healthy container for: ${result.down.join(', ')} (routes left as-is)`,
      );
    }
    if (result.errors.length > 0) {
      console.error(
        `[deploy-agent] reconcile (${trigger}) could not fully check: ${result.errors.join(', ')}`,
      );
    }
    if (
      result.repaired.length === 0 &&
      result.down.length === 0 &&
      result.errors.length === 0
    ) {
      console.info(
        `[deploy-agent] reconcile (${trigger}) checked ${result.checkedSlugs} site(s); every route matches its running container`,
      );
    }
    return result;
  } catch (e) {
    console.error(
      `[deploy-agent] reconcile (${trigger}) failed: ${e instanceof Error ? e.message : 'unknown error'}`,
    );
    return null;
  }
}

/**
 * Stage a tarball the caller streamed to us. Same verification and same temp
 * file as the URL path, so `handleDeploy` cannot tell the two apart after this
 * point.
 */
async function stageUploadedArtifact(
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<{ tarballPath: string; actualSha256: string; sizeBytes: number }> {
  if (!SHA256_HEX.test(expectedSha256)) {
    throw new Error('artifact_sha256 must be a 64-character hex sha256');
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256.toLowerCase() !== hash) {
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${hash}`);
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tarballPath = join(TEMP_ROOT, `${stamp}.tar.gz`);
  await writeFile(tarballPath, bytes);
  return { tarballPath, actualSha256: hash, sizeBytes: bytes.length };
}

async function handleDeploy(slug: string, body: DeployBody): Promise<Response> {
  const uploaded = body.artifact_bytes ?? null;
  if (
    !uploaded &&
    (typeof body.artifact_url !== 'string' || !body.artifact_url)
  ) {
    return jsonResponse(
      {
        error:
          'artifact_url required (or POST the tarball as application/octet-stream)',
      },
      400,
    );
  }
  // The caller always has this: `flowstarter-main`'s deploy path computes the
  // hash before it ever sends a URL or bytes here (packaging a site tarball
  // hashes it in the same step). Requiring it means nothing is extracted on
  // this host — where a wrong or tampered artifact would be — without the
  // caller having first committed, out of band from this one fetch, to what
  // the bytes are supposed to be.
  const sha256 = body.artifact_sha256 ?? '';
  if (!SHA256_HEX.test(sha256)) {
    return jsonResponse(
      {
        error:
          'artifact_sha256 is required and must be a 64-character hex sha256',
      },
      400,
    );
  }
  await ensureDirs();

  let fetched;
  try {
    fetched = uploaded
      ? await stageUploadedArtifact(uploaded, sha256)
      : await fetchAndVerify(body.artifact_url, sha256);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      uploaded ? 400 : 502,
    );
  }

  // Both, in sites mode. The final name is what the client was sold; the
  // preview name stays in the snippet where it is configured so an existing
  // host does not lose a hostname it is already answering on.
  const siteHost = hostFromTemplate(SITE_DOMAIN_TEMPLATE, slug);
  const previewHost = hostFromTemplate(PREVIEW_DOMAIN_TEMPLATE, slug);
  // The publisher sends the unguessable hostname as primary_domain for a
  // preview. Custom domains are meaningless for a preview and are ignored
  // rather than trusted.
  const previewHostname =
    body.primary_domain ?? `${slug}.${PREVIEW_HOST_SUFFIX}`;
  const buildSnippet = (target: ServeTarget): string =>
    MODE === 'previews'
      ? buildPreviewCaddySnippet(slug, target, previewHostname, SITE_PORT)
      : buildCaddySnippet(
          slug,
          target,
          body.primary_domain ?? null,
          body.additional_domains ?? [],
          previewHost,
          EDITOR_UPSTREAM,
          siteHost,
        );

  if (SITE_RUNTIME === 'docker') {
    let templates;
    try {
      templates = await siteRuntimeTemplates();
    } catch (e) {
      await rm(fetched.tarballPath, { force: true }).catch(() => undefined);
      return jsonResponse(
        {
          error:
            e instanceof Error
              ? e.message
              : 'site runtime templates unavailable',
        },
        500,
      );
    }

    let ports;
    try {
      ports = await assignPortsForSlug(slug);
    } catch (e) {
      await rm(fetched.tarballPath, { force: true }).catch(() => undefined);
      return jsonResponse(
        {
          error: `port assignment failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        },
        500,
      );
    }

    let outcome;
    try {
      outcome = await deployDockerSite(
        {
          slug,
          mode: MODE,
          tarballPath: fetched.tarballPath,
          sha256: fetched.actualSha256,
          templates,
          ports,
          buildSnippet: (upstream) => buildSnippet(dockerServeTarget(upstream)),
        },
        {
          runner: systemCommandRunner,
          isReady: httpReadinessCheck,
          readSnippet: readCaddySnippet,
          writeSnippet: writeCaddySnippet,
          reloadCaddy,
          readyTimeoutMs: DOCKER_READY_TIMEOUT_MS,
          readyIntervalMs: DOCKER_READY_INTERVAL_MS,
        },
      );
    } finally {
      await rm(fetched.tarballPath, { force: true }).catch(() => undefined);
    }
    if (!outcome.ok) {
      return jsonResponse({ error: outcome.error }, 500);
    }
    return jsonResponse({
      ok: true,
      slug,
      sha256: fetched.actualSha256,
      sizeBytes: fetched.sizeBytes,
      runtime: 'docker',
      containerName: outcome.containerName,
      imageName: outcome.imageName,
      port: outcome.port,
    });
  }

  const siteDir = resolve(SITES_ROOT, slug);
  try {
    await extractTarball(fetched.tarballPath, siteDir);
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : 'extract failed' },
      500,
    );
  } finally {
    await rm(fetched.tarballPath, { force: true }).catch(() => undefined);
  }

  try {
    await writeCaddySnippet(slug, buildSnippet(siteServeTarget(siteDir)));
  } catch (e) {
    return jsonResponse(
      {
        error: `caddy snippet write failed: ${e instanceof Error ? e.message : 'unknown'}`,
      },
      500,
    );
  }

  const reload = await reloadCaddy();
  if (!reload.ok) {
    return jsonResponse(
      { error: `caddy reload failed: ${reload.stderr}` },
      500,
    );
  }

  return jsonResponse({
    ok: true,
    slug,
    sha256: fetched.actualSha256,
    sizeBytes: fetched.sizeBytes,
    siteDir,
  });
}

async function handleRemove(slug: string): Promise<Response> {
  if (SITE_RUNTIME === 'docker') {
    await removeDockerSite(systemCommandRunner, MODE, slug);
    await releasePortsForSlug(slug).catch((e) => {
      console.error(
        `[deploy-agent] failed to release ports for "${slug}": ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    });
    await writeCaddySnippet(slug, '');
    const reload = await reloadCaddy();
    if (!reload.ok) {
      return jsonResponse(
        { error: `caddy reload failed: ${reload.stderr}` },
        500,
      );
    }
    return jsonResponse({ ok: true, slug });
  }

  const siteDir = resolve(SITES_ROOT, slug);
  await rm(siteDir, { recursive: true, force: true }).catch(() => undefined);
  await writeCaddySnippet(slug, '');
  const reload = await reloadCaddy();
  if (!reload.ok) {
    return jsonResponse(
      { error: `caddy reload failed: ${reload.stderr}` },
      500,
    );
  }
  return jsonResponse({ ok: true, slug });
}

async function readBody(req: Request): Promise<DeployBody> {
  // `HttpDeployAgentClient` supports both artifact shapes. Raw bytes carry the
  // domains in headers because there is no JSON envelope to put them in.
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.startsWith('application/octet-stream')) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    const additional = (req.headers.get('x-site-additional-domains') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return {
      artifact_url: '',
      artifact_bytes: bytes,
      artifact_sha256: req.headers.get('x-artifact-sha256'),
      primary_domain: req.headers.get('x-site-primary-domain') || null,
      additional_domains: additional,
    };
  }

  const text = await req.text();
  if (!text) return { artifact_url: '' };
  try {
    return JSON.parse(text) as DeployBody;
  } catch {
    return { artifact_url: '' };
  }
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Serve `<SITES_ROOT>/<slug>/<rest>` with the try_files behaviour the Caddy
 * snippets use: exact file, then `<rest>/index.html`, then the site's own
 * `index.html` so a client-routed page still resolves.
 *
 * Every candidate is re-resolved and checked to be inside the site directory,
 * so a `..` in the request path cannot read the host's filesystem.
 */
async function serveStatic(url: URL): Promise<Response> {
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const slug = decodeURIComponent(segments[0] ?? '').toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) {
    return new Response('Not found', { status: 404 });
  }
  const siteDir = resolve(SITES_ROOT, slug);
  if (!(await exists(siteDir))) {
    return new Response(`No site deployed for "${slug}"`, { status: 404 });
  }

  // A bare `/slug` must become `/slug/` or every relative asset on the page
  // resolves one level too high.
  if (segments.length === 1 && !url.pathname.endsWith('/')) {
    return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 308);
  }

  const rest = segments
    .slice(1)
    .map((segment) => decodeURIComponent(segment))
    .join('/');
  const candidates = rest
    ? [rest, `${rest}/index.html`, 'index.html']
    : ['index.html'];

  for (const candidate of candidates) {
    const target = resolve(siteDir, candidate);
    if (target !== siteDir && !target.startsWith(`${siteDir}/`)) continue;
    try {
      if (!(await stat(target)).isFile()) continue;
    } catch {
      continue;
    }
    return new Response(await readFile(target), {
      headers: {
        'Content-Type': contentTypeFor(target),
        // Dev only: a cached build is the fastest way to be confused about
        // whether a redeploy actually landed.
        'Cache-Control': 'no-store',
      },
    });
  }
  return new Response('Not found', { status: 404 });
}

/**
 * Bun's entrypoint guard: true when this file was run directly (`bun
 * src/index.ts`), false when another module `import`s it — which is how
 * the test files reach `handleDeploy`/`handleRemove` without opening a
 * real network port.
 */
/**
 * Routing, minus the error handling. Exported so the tests can drive every
 * endpoint without binding a port.
 */
export async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Unauthenticated on purpose: Caddy's on-demand TLS ask has no way to
  // send a bearer token. It is bound to loopback by the firewall and it
  // only ever reveals whether a given preview hostname is being served.
  if (url.pathname === '/tls-ask' && req.method === 'GET') {
    return handleTlsAsk(url.searchParams.get('domain'));
  }

  if (!authorized(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  /**
   * Authenticated, unlike the liveness probe it replaced.
   *
   * This is the endpoint a host connecting to flowstarter-main is checked
   * on (`lib/hosting/connect-existing-server.ts`), and the whole point of
   * that check is to prove the two sides hold the same shared secret
   * before the host is recorded as usable. An endpoint that answers
   * `ok: true` to anybody proves nothing, and it hands a scanner the
   * agent's mode and runtime for free.
   *
   * `siteRuntime` is part of the contract: the connect flow refuses a host
   * that is not running the Docker runtime.
   */
  if (url.pathname === '/health' && req.method === 'GET') {
    return jsonResponse({
      ok: true,
      version: VERSION,
      mode: MODE,
      siteRuntime: SITE_RUNTIME,
    });
  }

  /**
   * Manual trigger for the same reconciliation startup and the interval
   * run: every owned container's actual published port checked against
   * its Caddy snippet, drift repaired, one reload. For an operator who
   * just ran `docker restart` on a site by hand and does not want to wait
   * for the interval.
   */
  if (url.pathname === '/reconcile' && req.method === 'POST') {
    if (SITE_RUNTIME !== 'docker') {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: 'filesystem runtime has no containers to reconcile',
      });
    }
    const result = await runReconcile('manual');
    if (!result) {
      return jsonResponse(
        { error: 'reconcile failed; see the agent log' },
        500,
      );
    }
    return jsonResponse({ ok: true, ...result });
  }

  if (url.pathname.startsWith('/sites/')) {
    const slug = siteSlugFromPath(url.pathname);
    if (!slug) {
      return jsonResponse({ error: 'invalid slug' }, 400);
    }
    if (req.method === 'POST' && url.pathname === `/sites/${slug}/deploy`) {
      const body = await readBody(req);
      return withSlugLock(slug, () => handleDeploy(slug, body));
    }
    if (req.method === 'DELETE' && url.pathname === `/sites/${slug}`) {
      return withSlugLock(slug, () => handleRemove(slug));
    }
  }

  return jsonResponse({ error: 'not found' }, 404);
}

async function startServers(): Promise<void> {
  // Fail at boot, not on the first deploy, if the templates a Docker-mode
  // agent needs cannot be read.
  let templateSource = 'n/a';
  if (SITE_RUNTIME === 'docker') {
    try {
      templateSource = (await siteRuntimeTemplates()).source;
    } catch (e) {
      console.error(
        `[deploy-agent] ${e instanceof Error ? e.message : 'site runtime templates unavailable'}`,
      );
      process.exit(1);
    }
  }

  await ensureDirs();

  // The exact hazard this exists for: the host rebooted, Docker restarted
  // every container per its restart policy, and at least one of them came
  // back on a different port than the Caddy snippet still names. Checking
  // once here, before the agent starts accepting deploys, means a stale
  // route left over from before this boot gets repaired immediately
  // instead of waiting for the next interval tick.
  await runReconcile('startup');

  if (SITE_RUNTIME === 'docker' && RECONCILE_INTERVAL_MS > 0) {
    const interval = setInterval(() => {
      void runReconcile('interval');
    }, RECONCILE_INTERVAL_MS);
    // Never keeps the process alive by itself; only the HTTP servers below
    // do that, the way it already worked before this existed.
    interval.unref?.();
  }

  const server = Bun.serve({
    port: PORT,
    hostname: BIND_ADDRESS,
    async fetch(req) {
      try {
        return await routeRequest(req);
      } catch (e) {
        // Anything that escapes a handler becomes a JSON 500 rather than
        // Bun's default error page: the caller parses these as JSON, and a
        // stack trace in the body is not something to hand out.
        console.error('[deploy-agent] unhandled request error:', e);
        return jsonResponse({ error: 'internal error' }, 500);
      }
    },
  });

  const staticServer =
    STATIC_PORT !== null && Number.isFinite(STATIC_PORT)
      ? Bun.serve({
          port: STATIC_PORT,
          hostname: BIND_ADDRESS,
          fetch: (req) => serveStatic(new URL(req.url)),
        })
      : null;

  console.info(
    `[deploy-agent] v${VERSION} mode=${MODE} runtime=${SITE_RUNTIME} templates=${templateSource} ` +
      `listening on ${BIND_ADDRESS}:${server.port} ` +
      `(sites root ${SITES_ROOT}, caddy snippets ${CADDY_SITES_DIR})`,
  );
  if (staticServer) {
    console.info(
      `[deploy-agent] serving extracted sites on http://localhost:${staticServer.port}/{slug}/`,
    );
  }
}

if (import.meta.main) {
  await startServers();
}
