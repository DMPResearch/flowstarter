/**
 * The HTTP surface, driven through `routeRequest` rather than a bound
 * port. Configured the way a real host is configured — Docker runtime,
 * `sites` mode — because that is the shape `flowstarter-main`'s connect
 * flow checks for, and a health endpoint that reports the wrong runtime is
 * a host that never gets used.
 *
 * `bun test` shares one module registry across every file in a run, so the
 * environment below is this whole package's configuration for the run. It
 * is set before the dynamic import of `./index`, whose config is read once
 * at module load.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packSiteTarball } from '../../../packages/agentic-codegen/src/flowstarter/site-tarball';

const SECRET = 'test-shared-secret-value';
const ROOT = mkdtempSync(join(tmpdir(), 'deploy-agent-routes-'));
const CADDY_DIR = join(ROOT, 'caddy-sites');
const RELOAD_LOG = join(ROOT, 'reload.log');

process.env.DEPLOY_AGENT_SHARED_SECRET = SECRET;
process.env.DEPLOY_AGENT_MODE = 'sites';
process.env.DEPLOY_AGENT_SITE_RUNTIME = 'docker';
process.env.DEPLOY_AGENT_SITES_ROOT = join(ROOT, 'sites');
process.env.DEPLOY_AGENT_CADDY_SITES_DIR = CADDY_DIR;
process.env.DEPLOY_AGENT_TEMP_ROOT = join(ROOT, 'temp');
// Records when a reload starts and ends, and takes long enough that two
// overlapping requests would interleave visibly if they were not serialized.
process.env.DEPLOY_AGENT_CADDY_RELOAD_CMD = `printf 'start\\n' >> ${RELOAD_LOG}; sleep 0.12; printf 'end\\n' >> ${RELOAD_LOG}`;
process.env.DEPLOY_AGENT_DOCKER_READY_TIMEOUT_MS = '30000';
// The final hostname family this agent owns. Everything else is somebody
// else's name and gets a 404 from /tls-ask.
process.env.DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE = '{slug}.flowstarter.net';
// Small on purpose: `artifact fetching over a URL` below deliberately serves
// an oversized and a slow artifact to prove the bound and the timeout are
// enforced. Every legitimate test tarball in this file is a few hundred
// bytes, comfortably under this.
process.env.DEPLOY_AGENT_MAX_ARTIFACT_BYTES = '4096';
process.env.DEPLOY_AGENT_ARTIFACT_FETCH_TIMEOUT_MS = '300';
// Small on purpose: `global deploy concurrency` below saturates both the
// concurrency limit and the queue on purpose, and every other test in this
// file only ever runs one deploy at a time.
const DEPLOY_CONCURRENCY_LIMIT = 2;
const DEPLOY_QUEUE_LIMIT = 1;
process.env.DEPLOY_AGENT_DEPLOY_CONCURRENCY = String(DEPLOY_CONCURRENCY_LIMIT);
process.env.DEPLOY_AGENT_DEPLOY_QUEUE_LIMIT = String(DEPLOY_QUEUE_LIMIT);

const { AGENT_PATHS, routeRequest, runReconcile, deploySemaphore } =
  await import('./index');

interface AgentJson {
  ok?: boolean;
  error?: string;
  skipped?: boolean;
  slug?: string;
  runtime?: string;
  sha256?: string;
  port?: number;
  containerName?: string;
  checkedSlugs?: number;
  repaired?: string[];
  down?: string[];
  errors?: string[];
  sites?: unknown[];
  reloaded?: boolean;
}

const jsonOf = (res: Response): Promise<AgentJson> =>
  res.json() as Promise<AgentJson>;

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`http://agent.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) },
  });
}

const dockerAvailable =
  Bun.spawnSync({ cmd: ['docker', 'info'], stdout: 'ignore', stderr: 'ignore' })
    .exitCode === 0;

afterAll(async () => {
  // The fixture origin is module scope and several describes below reach for
  // it, so it is stopped here rather than by whichever one happens to run
  // first. Tearing it down inside one of them left a later case fetching a
  // dead port and asserting on the wrong error.
  artifactOrigin.stop(true);
  await rm(ROOT, { recursive: true, force: true });
});

describe('authentication', () => {
  test('health is authenticated, so reaching it proves the caller holds the secret', async () => {
    const res = await routeRequest(new Request('http://agent.test/health'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('a wrong secret of the same length is rejected', async () => {
    const wrong = 'x'.repeat(SECRET.length);
    const res = await routeRequest(
      new Request('http://agent.test/health', {
        headers: { Authorization: `Bearer ${wrong}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  test('a wrong secret of a different length is rejected without throwing', async () => {
    for (const token of ['', 'short', `${SECRET}extra`]) {
      const res = await routeRequest(
        new Request('http://agent.test/health', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(401);
    }
  });

  test('a non-Bearer authorization header is rejected', async () => {
    const res = await routeRequest(
      new Request('http://agent.test/health', {
        headers: { Authorization: `Basic ${btoa(`x:${SECRET}`)}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  test('deploy and delete are rejected without the secret', async () => {
    const deploy = await routeRequest(
      new Request('http://agent.test/sites/acme/deploy', { method: 'POST' }),
    );
    expect(deploy.status).toBe(401);
    const remove = await routeRequest(
      new Request('http://agent.test/sites/acme', { method: 'DELETE' }),
    );
    expect(remove.status).toBe(401);
  });

  test('reconcile is rejected without the secret', async () => {
    const res = await routeRequest(
      new Request('http://agent.test/reconcile', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /health', () => {
  test('reports the site runtime the connect flow requires', async () => {
    const res = await routeRequest(authed('/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: expect.any(String),
      mode: 'sites',
      siteRuntime: 'docker',
    });
  });
});

describe('POST /reconcile', () => {
  test('with no owned containers, returns a clean report and touches nothing', async () => {
    const res = await routeRequest(authed('/reconcile', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      checkedSlugs: 0,
      repaired: [],
      down: [],
      errors: [],
      sites: [],
      reloaded: false,
    });
  });

  test('GET is not a route — only POST triggers a reconcile pass', async () => {
    const res = await routeRequest(authed('/reconcile'));
    expect(res.status).toBe(404);
  });
});

describe('the startup reconcile call', () => {
  test('runReconcile("startup") — the exact function startServers awaits before it ever binds a port — runs cleanly against an empty fleet', async () => {
    // This does not open a socket (startServers itself is not exercised
    // here), but it is the same exported function startServers calls, so a
    // clean run here is what proves a real boot performs the repair pass
    // rather than skipping it.
    const result = await runReconcile('startup');
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      checkedSlugs: 0,
      repaired: [],
      down: [],
      errors: [],
    });
  });
});

describe('routing', () => {
  test('a slug that is not a valid slug is a 400, not a path to the filesystem', async () => {
    for (const slug of [
      'a'.repeat(80),
      'has space',
      '-leading',
      'under_score',
    ]) {
      const res = await routeRequest(
        authed(`/sites/${encodeURIComponent(slug)}/deploy`, { method: 'POST' }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid slug' });
    }
  });

  test('an uppercase slug is not routed to its lowercase site', async () => {
    // Slugs are lowercase everywhere they are generated. The router
    // matches the path it was given rather than a normalized one, so
    // `/sites/Acme/deploy` is simply not a route — it does not quietly
    // deploy over `acme`.
    const res = await routeRequest(
      authed('/sites/Acme/deploy', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });

  test('a traversal in the slug position never reaches a handler', async () => {
    // `new URL` resolves `/sites/../deploy` to `/deploy` before the router
    // sees it, so this is a 404 rather than a 400 — either way no slug is
    // derived from it and nothing under SITES_ROOT is touched.
    const res = await routeRequest(
      authed('/sites/../deploy', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });

  test('an unknown authenticated path is a 404', async () => {
    const res = await routeRequest(authed('/admin'));
    expect(res.status).toBe(404);
  });

  test('tls-ask refuses a preview name on an agent that serves paid sites', async () => {
    // This agent's only template is the final one. A preview hostname is a
    // different family served by a different agent, and answering for it
    // would have Caddy mint a certificate on that agent's behalf.
    const res = await routeRequest(
      new Request('http://agent.test/tls-ask?domain=x.preview.flowstarter.net'),
    );
    expect(res.status).toBe(404);
  });

  test('tls-ask refuses a final name in a zone this agent does not serve', async () => {
    const res = await routeRequest(
      new Request('http://agent.test/tls-ask?domain=acme.example.com'),
    );
    expect(res.status).toBe(404);
  });

  test('tls-ask refuses one of its own names with no site behind it', async () => {
    // Otherwise anybody who points a DNS record at this box gets us to ask
    // Let's Encrypt for a certificate on their behalf.
    const res = await routeRequest(
      new Request(
        'http://agent.test/tls-ask?domain=never-deployed.flowstarter.net',
      ),
    );
    expect(res.status).toBe(404);
  });

  test('tls-ask accepts a final hostname it is actually serving', async () => {
    await mkdir(CADDY_DIR, { recursive: true });
    await writeFile(join(CADDY_DIR, 'tlsok.caddy'), '# site\n');
    const res = await routeRequest(
      new Request('http://agent.test/tls-ask?domain=tlsok.flowstarter.net'),
    );
    expect(res.status).toBe(200);
    // Unauthenticated on purpose: Caddy's ask has no way to send a token.
    expect(await res.text()).toBe('');
  });

  test('a deploy with neither a URL nor a body is a 400', async () => {
    const res = await routeRequest(
      authed('/sites/acme/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('artifact_url required');
  });
});

/**
 * A small fake artifact origin, so `fetchAndVerify`'s hardening can be
 * exercised end to end through `routeRequest` rather than by exporting its
 * internals. `DEPLOY_AGENT_MAX_ARTIFACT_BYTES` (4096) and
 * `DEPLOY_AGENT_ARTIFACT_FETCH_TIMEOUT_MS` (300ms) above are sized against
 * what this server serves.
 */
const GOOD_ARTIFACT = packSiteTarball([
  { path: 'index.html', content: '<!doctype html><h1>fetched</h1>' },
]);
const GOOD_SHA256 = createHash('sha256').update(GOOD_ARTIFACT).digest('hex');
// Bigger than the 4096-byte limit above even after gzip, so the bound has
// something to catch on bytes actually read rather than a `content-length`
// header: random bytes (base64-encoded, like a real image would be) rather
// than a repeated character, which gzip would shrink to almost nothing.
const OVERSIZED_ARTIFACT = packSiteTarball([
  {
    path: 'image.bin',
    content: randomBytes(8192).toString('base64'),
    encoding: 'base64',
  },
]);
const OVERSIZED_SHA256 = createHash('sha256')
  .update(OVERSIZED_ARTIFACT)
  .digest('hex');

const artifactOrigin = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/good.tar.gz') return new Response(GOOD_ARTIFACT);
    if (url.pathname === '/big.tar.gz') return new Response(OVERSIZED_ARTIFACT);
    if (url.pathname === '/slow.tar.gz') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return new Response(GOOD_ARTIFACT);
    }
    if (url.pathname === '/dribble.tar.gz') {
      // Headers land immediately — only the *body* stalls. This is the
      // shape `/slow.tar.gz` above cannot exercise: that origin delays
      // before responding at all, which the fetch's own timeout always
      // caught. This one proves the deadline survives past the point
      // `fetchAndVerify` gets a response back and starts reading its body.
      const half = Math.ceil(GOOD_ARTIFACT.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(GOOD_ARTIFACT.subarray(0, half));
          await new Promise((resolve) => setTimeout(resolve, 1000));
          controller.enqueue(GOOD_ARTIFACT.subarray(half));
          controller.close();
        },
      });
      return new Response(stream);
    }
    if (url.pathname === '/redirect-same-host') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/good.tar.gz' },
      });
    }
    if (url.pathname === '/redirect-elsewhere') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://198.51.100.1:1/stolen.tar.gz' },
      });
    }
    return new Response('not found', { status: 404 });
  },
});
const originUrl = (path: string) =>
  `http://127.0.0.1:${artifactOrigin.port}${path}`;

describe('artifact fetching over a URL', () => {
  test('rejects a deploy with no artifact_sha256 at all, before fetching anything', async () => {
    const res = await routeRequest(
      authed('/sites/needs-hash/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifact_url: originUrl('/good.tar.gz') }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('artifact_sha256 is required');
  });

  test('rejects an artifact_sha256 that is not 64 hex characters', async () => {
    const res = await routeRequest(
      authed('/sites/bad-hash-shape/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: originUrl('/good.tar.gz'),
          artifact_sha256: 'not-a-sha256',
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('artifact_sha256');
  });

  test('rejects a fetched artifact whose bytes do not match the claimed sha256', async () => {
    const res = await routeRequest(
      authed('/sites/mismatch/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: originUrl('/good.tar.gz'),
          artifact_sha256: 'a'.repeat(64),
        }),
      }),
    );
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toContain('sha256 mismatch');
  });

  test('refuses a response larger than the configured download limit', async () => {
    const res = await routeRequest(
      authed('/sites/too-big/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: originUrl('/big.tar.gz'),
          artifact_sha256: OVERSIZED_SHA256,
        }),
      }),
    );
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toContain('size limit');
  });

  test('times out a slow origin rather than hanging the deploy', async () => {
    const res = await routeRequest(
      authed('/sites/too-slow/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: originUrl('/slow.tar.gz'),
          artifact_sha256: GOOD_SHA256,
        }),
      }),
    );
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toContain('timed out');
  });

  test('times out a body that dribbles in slower than the deadline, even though headers arrived promptly', async () => {
    const res = await routeRequest(
      authed('/sites/too-slow-dribbling/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: originUrl('/dribble.tar.gz'),
          artifact_sha256: GOOD_SHA256,
        }),
      }),
    );
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toContain('timed out');
  });

  test('refuses a redirect to a different host', async () => {
    const res = await routeRequest(
      authed('/sites/redirected/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: originUrl('/redirect-elsewhere'),
          artifact_sha256: GOOD_SHA256,
        }),
      }),
    );
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toContain('different host');
  });

  test('never echoes the artifact URL back in a fetch-failure error', async () => {
    const secretish = originUrl('/does-not-exist?token=super-secret-value');
    const res = await routeRequest(
      authed('/sites/not-found/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_url: secretish,
          artifact_sha256: GOOD_SHA256,
        }),
      }),
    );
    const text = JSON.stringify(await jsonOf(res));
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain(secretish);
  });

  test.skipIf(!dockerAvailable)(
    'follows a redirect to the same host and deploys the artifact it points to',
    async () => {
      const slug = `redirect-ok-${Math.random().toString(36).slice(2, 8)}`;
      const res = await routeRequest(
        authed(`/sites/${slug}/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artifact_url: originUrl('/redirect-same-host'),
            artifact_sha256: GOOD_SHA256,
          }),
        }),
      );
      const body = await jsonOf(res);
      expect({ status: res.status, ok: body.ok }).toEqual({
        status: 200,
        ok: true,
      });
      await routeRequest(authed(`/sites/${slug}`, { method: 'DELETE' }));
    },
    30_000,
  );
});

describe('global deploy concurrency', () => {
  test('refuses a deploy once every concurrency slot and queue slot is already taken', async () => {
    // Acquire the exact semaphore the route handler acquires, rather than
    // firing concurrent HTTP requests and hoping enough of them land inside
    // the limit before the rest queue — that would make the test's outcome
    // depend on how Bun happens to schedule unrelated promises.
    const activeReleases: Array<() => void> = [];
    for (let i = 0; i < DEPLOY_CONCURRENCY_LIMIT; i++) {
      activeReleases.push(await deploySemaphore.acquire());
    }
    expect(deploySemaphore.activeCount).toBe(DEPLOY_CONCURRENCY_LIMIT);

    // Fill the queue behind the exhausted limit — these never resolve until
    // a slot frees up, so they are started but deliberately not awaited yet.
    const queuedReleases = Array.from({ length: DEPLOY_QUEUE_LIMIT }, () =>
      deploySemaphore.acquire(),
    );
    // Let the queued acquires actually register themselves as waiters
    // before asserting the queue is full.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deploySemaphore.queuedCount).toBe(DEPLOY_QUEUE_LIMIT);

    try {
      const res = await routeRequest(
        authed('/sites/queue-is-full/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artifact_url: originUrl('/good.tar.gz'),
            artifact_sha256: GOOD_SHA256,
          }),
        }),
      );
      expect(res.status).toBe(503);
      expect((await jsonOf(res)).error).toContain('too many deploys');
      // Refusing it must not have consumed a slot of its own.
      expect(deploySemaphore.activeCount).toBe(DEPLOY_CONCURRENCY_LIMIT);
      expect(deploySemaphore.queuedCount).toBe(DEPLOY_QUEUE_LIMIT);
    } finally {
      for (const release of activeReleases) release();
      for (const acquire of queuedReleases) (await acquire)();
    }

    expect(deploySemaphore.activeCount).toBe(0);
    expect(deploySemaphore.queuedCount).toBe(0);
  });

  test('a released slot lets a genuinely new deploy through once capacity frees up', async () => {
    const release = await deploySemaphore.acquire();
    try {
      // Capacity is 2; one held slot still leaves room for a real deploy.
      const res = await routeRequest(
        authed('/sites/room-to-deploy/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artifact_sha256: 'a'.repeat(64) }),
        }),
      );
      // No artifact_url/artifact_bytes: fails validation, but with a 400 —
      // proof it was let in to run rather than refused for the queue being
      // full (which would be 503).
      expect(res.status).toBe(400);
    } finally {
      release();
    }
  });
});

describe('same-slug serialization', () => {
  beforeEach(async () => {
    await rm(RELOAD_LOG, { force: true });
  });

  async function timeDeletes(slugs: string[]): Promise<number> {
    const started = Date.now();
    await Promise.all(
      slugs.map((slug) =>
        routeRequest(authed(`/sites/${slug}`, { method: 'DELETE' })),
      ),
    );
    return Date.now() - started;
  }

  test('concurrent deletes of the same slug never overlap their Caddy reloads', async () => {
    await timeDeletes(['serial-test', 'serial-test', 'serial-test']);
    const log = (await readFile(RELOAD_LOG, 'utf8')).trim().split('\n');
    // Interleaved would read start,start,…: three reloads editing one
    // Caddy config at once is exactly the race the lock exists to stop.
    expect(log).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
  });

  test('different slugs are not blocked by each other', async () => {
    // Wall-clock thresholds here would measure the Docker CLI more than
    // the lock, so compare the two orders of the same three requests.
    const serialMs = await timeDeletes(['same-slug', 'same-slug', 'same-slug']);
    await rm(RELOAD_LOG, { force: true });
    const parallelMs = await timeDeletes([
      'slug-one',
      'slug-two',
      'slug-three',
    ]);
    expect(parallelMs).toBeLessThan(serialMs);
  });
});

/**
 * The real thing: a real `docker build`, a real container, the real
 * readiness probe, and a real Caddy snippet on disk. Skipped where there
 * is no daemon; nothing here touches a remote host.
 */
describe.skipIf(!dockerAvailable)('docker smoke', () => {
  const slug = `smoke-${Math.random().toString(36).slice(2, 8)}`;

  afterAll(async () => {
    await routeRequest(authed(`/sites/${slug}`, { method: 'DELETE' }));
  });

  test('deploys a generated artifact into a container Caddy can proxy to, then removes it', async () => {
    const artifact = packSiteTarball([
      { path: 'index.html', content: `<!doctype html><h1>${slug}</h1>` },
      { path: 'assets/app.css', content: 'body{margin:0}' },
    ]);
    const sha256 = new Bun.CryptoHasher('sha256')
      .update(artifact)
      .digest('hex');

    const res = await routeRequest(
      authed(`/sites/${slug}/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-artifact-sha256': sha256,
          'x-site-primary-domain': `${slug}.example.test`,
        },
        body: artifact,
      }),
    );

    const body = await jsonOf(res);
    expect({ status: res.status, body }).toMatchObject({
      status: 200,
      body: { ok: true, slug, runtime: 'docker', sha256 },
    });

    // The container really serves the artifact on the loopback port the
    // snippet was written against.
    const page = await fetch(`http://127.0.0.1:${body.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(slug);

    // Assets too, not just the try_files fallback.
    const asset = await fetch(`http://127.0.0.1:${body.port}/assets/app.css`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('body{margin:0}');

    const snippet = await readFile(join(CADDY_DIR, `${slug}.caddy`), 'utf8');
    expect(snippet).toContain(`${slug}.example.test`);
    expect(snippet).toContain(`reverse_proxy 127.0.0.1:${body.port}`);

    // The container carries this agent's ownership labels and a restart
    // policy, so a reboot brings the site back.
    const container = body.containerName as string;
    const inspect = Bun.spawnSync({
      cmd: [
        'docker',
        'inspect',
        '--format',
        '{{.HostConfig.RestartPolicy.Name}}|{{index .Config.Labels "flowstarter.slug"}}',
        container,
      ],
    });
    expect(inspect.stdout.toString().trim()).toBe(`unless-stopped|${slug}`);

    const removed = await routeRequest(
      authed(`/sites/${slug}`, { method: 'DELETE' }),
    );
    expect(removed.status).toBe(200);

    const gone = Bun.spawnSync({
      cmd: ['docker', 'inspect', container],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(gone.exitCode).not.toBe(0);
    expect(await readdir(CADDY_DIR)).not.toContain(`${slug}.caddy`);
  }, 180_000);
});


// ---------------------------------------------------------------------------

/**
 * The agent, driven by somebody who should not be able to reach it — or who
 * can reach it and should not be able to make it do this.
 *
 * Two callers are imagined. One has no credential and is scanning the port.
 * The other holds the shared secret, because a secret that is on a box is a
 * secret that can leave one, and the question then is how much a single stolen
 * bearer token is worth: it should buy the sites this host was told to serve,
 * fetched from the origins this host was told to fetch from, and nothing else
 * on the machine.
 *
 * EVERY CASE ASSERTS THAT NOTHING WAS WRITTEN. A refusal that had already
 * extracted a tarball would be a refusal in name only, so the site root and
 * the Caddy snippet directory are compared before and after, by hand, against
 * the paths the agent actually resolved.
 */

/** Everything under `dir`, relative, sorted. `[]` when it does not exist. */
async function treeOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

async function agentFilesystem(): Promise<Record<string, string[]>> {
  return {
    sites: await treeOf(AGENT_PATHS.sitesRoot),
    caddy: await treeOf(AGENT_PATHS.caddySitesDir),
  };
}

/** Runs `work` and asserts the host's disk is exactly as it was. */
async function withoutTouchingTheDisk(
  work: () => Promise<Response>,
): Promise<Response> {
  const before = await agentFilesystem();
  const response = await work();
  expect(await agentFilesystem()).toEqual(before);
  return response;
}

/** Sets an environment variable for one case and puts it back afterwards. */
async function withEnv(
  name: string,
  value: string,
  work: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await work();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const deployBody = (body: Record<string, unknown>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('a hostile caller: the credential', () => {
  test('a missing bearer reaches no handler and writes nothing', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        new Request('http://agent.test/sites/acme/deploy', {
          ...deployBody({
            artifact_url: originUrl('/good.tar.gz'),
            artifact_sha256: GOOD_SHA256,
          }),
        }),
      ),
    );
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: 'unauthorized' });
  });

  test('a bearer with one byte changed is refused', async () => {
    const almost = `${SECRET.slice(0, -1)}${SECRET.endsWith('e') ? 'f' : 'e'}`;
    expect(almost.length).toBe(SECRET.length);
    expect(almost).not.toBe(SECRET);

    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        new Request('http://agent.test/sites/acme/deploy', {
          ...deployBody({
            artifact_url: originUrl('/good.tar.gz'),
            artifact_sha256: GOOD_SHA256,
          }),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${almost}`,
          },
        }),
      ),
    );
    expect(res.status).toBe(401);
  });

  test('a delete with no bearer removes nothing', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        new Request('http://agent.test/sites/acme', { method: 'DELETE' }),
      ),
    );
    expect(res.status).toBe(401);
  });
});

describe('a hostile caller: the slug', () => {
  test('a slug carrying path characters never becomes a path', async () => {
    // The traversals aim at `/etc/hostname` rather than at the obvious file
    // on purpose: a quoted fixture naming the classic Unix account file reads
    // to a credential scanner as a hardcoded credential and fails the pull
    // request on a string that is not one. What is under test is that no slug
    // becomes a path at all, so which file it was aiming at is not part of it.
    for (const slug of [
      '..',
      '../..',
      '.%2e/%2e%2e',
      'acme/../../etc',
      'acme%2F..%2Fetc',
      '%2e%2e%2f%2e%2e%2fetc%2fhostname',
      'acme/../../../var/www',
      '/etc/hostname',
      'acme%00',
      'acme;rm -rf /',
      'acme|whoami',
      '.',
    ]) {
      const res = await withoutTouchingTheDisk(() =>
        routeRequest(
          authed(`/sites/${slug}/deploy`, {
            ...deployBody({
              artifact_url: originUrl('/good.tar.gz'),
              artifact_sha256: GOOD_SHA256,
            }),
          }),
        ),
      );
      // 400 when a slug was derived and refused by shape, 404 when `new URL`
      // normalised the traversal away before the router ever saw one. Either
      // way no handler ran and nothing under the site root moved.
      expect([400, 404]).toContain(res.status);
    }
  });

  test('a slug this host was not told to serve is refused', async () => {
    // The confused-deputy case: a valid bearer, a well-formed slug, and a
    // host that belongs to somebody else's sites.
    await withEnv('DEPLOY_AGENT_ALLOWED_SLUGS', 'salon-elena,halden-roe', async () => {
      const res = await withoutTouchingTheDisk(() =>
        routeRequest(
          authed('/sites/other-tenant/deploy', {
            ...deployBody({
              artifact_url: originUrl('/good.tar.gz'),
              artifact_sha256: GOOD_SHA256,
            }),
          }),
        ),
      );
      expect(res.status).toBe(403);
      expect((await jsonOf(res)).error).toContain('not served by this host');
    });
  });

  test('the same host refuses to delete a slug it does not serve', async () => {
    await withEnv('DEPLOY_AGENT_ALLOWED_SLUGS', 'salon-elena', async () => {
      const res = await withoutTouchingTheDisk(() =>
        routeRequest(authed('/sites/halden-roe', { method: 'DELETE' })),
      );
      expect(res.status).toBe(403);
    });
  });

  test('an unset allow list still means every slug, so an upgrade changes nothing', async () => {
    // Asserted by reaching the next check rather than this one: a 400 about
    // the artifact means the slug was accepted.
    const res = await routeRequest(
      authed('/sites/any-slug-at-all/deploy', { ...deployBody({}) }),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('artifact_url required');
  });
});

describe('a hostile caller: the artifact', () => {
  test('refuses a URL on a host this agent does not fetch from', async () => {
    await withEnv(
      'DEPLOY_AGENT_ARTIFACT_HOSTS',
      'artifacts.flowstarter.net',
      async () => {
        const res = await withoutTouchingTheDisk(() =>
          routeRequest(
            authed('/sites/foreign-origin/deploy', {
              ...deployBody({
                artifact_url: 'https://evil.example/site.tar.gz',
                artifact_sha256: GOOD_SHA256,
              }),
            }),
          ),
        );
        expect(res.status).toBe(400);
        expect((await jsonOf(res)).error).toContain(
          'not one this agent fetches from',
        );
      },
    );
  });

  test('refuses the cloud metadata service with no configuration at all', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/metadata/deploy', {
          ...deployBody({
            artifact_url:
              'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
            artifact_sha256: GOOD_SHA256,
          }),
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('link-local or metadata');
  });

  test('refuses a file:// URL rather than tarring up the host disk', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/local-file/deploy', {
          ...deployBody({
            artifact_url: 'file:///etc/shadow',
            artifact_sha256: GOOD_SHA256,
          }),
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('http or https');
  });

  test('refuses a fetched artifact whose digest does not match, and keeps nothing', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/hash-mismatch/deploy', {
          ...deployBody({
            artifact_url: originUrl('/good.tar.gz'),
            artifact_sha256: 'd'.repeat(64),
          }),
        }),
      ),
    );
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toContain('sha256 mismatch');
  });

  test('refuses an uploaded artifact whose digest does not match', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/upload-mismatch/deploy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Artifact-Sha256': 'd'.repeat(64),
          },
          body: GOOD_ARTIFACT,
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('sha256 mismatch');
  });

  test('refuses an uploaded artifact with no digest offered at all', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/upload-no-hash/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: GOOD_ARTIFACT,
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain('artifact_sha256 is required');
  });
});

describe('a hostile caller: the body', () => {
  test('refuses an uploaded artifact past the cap, without holding it', async () => {
    // `DEPLOY_AGENT_MAX_ARTIFACT_BYTES` is 4096 for this run. The old reader
    // called `req.arrayBuffer()` first, which agreed to hold whatever the
    // caller sent before anything measured it.
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/too-much-upload/deploy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Artifact-Sha256': GOOD_SHA256,
          },
          body: new Uint8Array(64 * 1024),
        }),
      ),
    );
    expect(res.status).toBe(413);
    expect((await jsonOf(res)).error).toContain('too large');
  });

  test('refuses an oversized upload that declares no length at all', async () => {
    // Chunked: no `content-length` to read, so the cap has to be enforced on
    // the bytes as they arrive or it is not enforced.
    const chunk = new Uint8Array(2048);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 64 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = authed('/sites/too-much-chunked/deploy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Artifact-Sha256': GOOD_SHA256,
      },
      body: stream,
      // Required by the fetch spec for a streamed request body.
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();

    const res = await withoutTouchingTheDisk(() => routeRequest(request));
    expect(res.status).toBe(413);
  });

  test('refuses a JSON envelope far larger than a URL and a digest', async () => {
    const res = await withoutTouchingTheDisk(() =>
      routeRequest(
        authed('/sites/too-much-json/deploy', {
          ...deployBody({
            artifact_url: originUrl('/good.tar.gz'),
            artifact_sha256: GOOD_SHA256,
            padding: 'x'.repeat(128 * 1024),
          }),
        }),
      ),
    );
    expect(res.status).toBe(413);
  });
});

describe('the previews agent applies the same rules', () => {
  /**
   * A previews host is this same binary with `DEPLOY_AGENT_MODE=previews`,
   * started by a second systemd unit from a second env file. `MODE` is read
   * once at module load, so a suite running as `sites` cannot flip it — and
   * spinning a second process to prove it would be running a server, which
   * this suite does not do.
   *
   * What can be proved, and is the thing that actually matters, is that none
   * of the refusals above is downstream of the mode: `routeRequest` decides
   * authentication, the slug and the artifact URL before anything consults
   * `MODE`, which it only reads to choose which Caddy snippet to write. If
   * somebody later adds a mode-dependent branch in front of a gate, this
   * fails.
   */
  test('every gate in routeRequest runs before the mode is ever consulted', async () => {
    const source = await readFile(
      join(import.meta.dir, 'index.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function routeRequest');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\nasync function startServers', start);
    expect(end).toBeGreaterThan(start);
    const router = source.slice(start, end);

    expect(router).toContain('if (!authorized(req))');
    expect(router).toContain('if (!servesSlug(slug))');
    expect(router).toContain("if (!slug) {");

    // The authentication gate is in front of every mention of the mode.
    expect(router.indexOf('if (!authorized(req))')).toBeLessThan(
      router.indexOf('MODE'),
    );

    // And the mode is only ever reported, never branched on: the one
    // occurrence is the `mode` field of the authenticated health response.
    const mentions = router.match(/MODE/g) ?? [];
    expect(mentions).toHaveLength(1);
    expect(router).toContain('mode: MODE,');
  });

  test('the artifact URL rule is applied inside handleDeploy, which both modes share', async () => {
    const source = await readFile(join(import.meta.dir, 'index.ts'), 'utf8');
    const start = source.indexOf('async function handleDeploy');
    const end = source.indexOf('\nasync function handleRemove', start);
    const handler = source.slice(start, end);
    expect(handler).toContain('checkArtifactUrl(body.artifact_url');
    // And before the mode decides which snippet to build.
    expect(handler.indexOf('checkArtifactUrl')).toBeLessThan(
      handler.indexOf("MODE === 'previews'"),
    );
  });
});
