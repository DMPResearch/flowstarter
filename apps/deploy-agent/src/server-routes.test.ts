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

const { routeRequest } = await import('./index');

interface AgentJson {
  ok?: boolean;
  error?: string;
  slug?: string;
  runtime?: string;
  sha256?: string;
  port?: number;
  containerName?: string;
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
  afterAll(() => {
    artifactOrigin.stop(true);
  });

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
