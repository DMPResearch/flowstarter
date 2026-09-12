/**
 * End-to-end: a paid deposit becomes a site you can open in a browser.
 *
 * `full-flow.test.ts` covers the production leg that ends at a GitHub pull
 * request. This covers the local leg that ends at a served URL — the one that
 * has to work on a laptop with no Hetzner host, no sites repo and no model
 * key, and the one the browser exercise then repeats by hand:
 *
 *   real Stripe-signed webhook payload
 *     -> real POST handler in app/api/webhooks/stripe/route.ts
 *     -> real enqueueFullBuildFromDeposit + real dispatch over HTTP
 *     -> real build-worker HTTP surface, bearer auth and BuildQueue
 *     -> real SupabaseFullSiteBuildJobStore claim (over real supabase-js)
 *     -> real SafeGitWorktreeManager (real `git worktree add`)
 *     -> real materializeScaffold of the approved preview
 *     -> real applyIntegrationsToWorkspace: the blurred Cal demo the funnel
 *        published becomes the tenant's live embed
 *     -> [stub] the Pi coding session
 *     -> real CommandSiteValidator (a real subprocess producing a real dist/)
 *     -> real `git commit`
 *     -> real LocalSitePublisher: collect dist/, pack a real tarball
 *     -> real POST /api/internal/build/deploy (bearer-authorized)
 *     -> real deploySite: deployments ledger, workspace deploy_status
 *     -> real HttpDeployAgentClient over real HTTP
 *     -> [stand-in] deploy-agent: real `tar -xzf`, real static serving
 *     -> a real GET that returns the built HTML with the live calendar in it
 *
 * Two boundaries are stubbed, both because a test cannot reach them: the LLM
 * provider, and the Bun runtime the real deploy-agent binary needs. The
 * stand-in agent runs the same `tar -xzf` into the same layout and serves the
 * same `{slug}/…` paths, so what it proves about the bytes is real.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import {
  FullSiteBuildWorker,
  injectCalComPreviewDemo,
  ProjectState,
  SafeGitWorktreeManager,
  type PiSdkFlowstarterAgents,
} from '@flowstarter/agentic-codegen';
import { createClient } from '@supabase/supabase-js';
import { ArtifactStore } from '@flowstarter/build-worker/src/artifacts';
import { handleRequest } from '@flowstarter/build-worker/src/http';
import { SupabaseFullSiteBuildJobStore } from '@flowstarter/build-worker/src/job-store';
import { LocalSitePublisher } from '@flowstarter/build-worker/src/local-publisher';
import { BuildQueue } from '@flowstarter/build-worker/src/queue';
import { CommandSiteValidator } from '@flowstarter/build-worker/src/validator';
import { startFakePostgrest, type FakePostgrest } from './fake-postgrest';

const execFileAsync = promisify(execFile);

const hoisted = vi.hoisted(() => ({ restUrl: '' }));

vi.mock('@/supabase-clients/server', async () => {
  const { createClient: create } = await import('@supabase/supabase-js');
  return {
    createSupabaseServiceRoleClient: () =>
      create(hoisted.restUrl, 'test-service-role-key', {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
  };
});

// vi.mock is hoisted above these, so both routes resolve the fake client.
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';
import { POST as internalDeploy } from '@/app/api/internal/build/deploy/route';

const WORKSPACE_ID = '3d2f6a71-4c58-4a1e-9f13-7c0b5a2d9e64';
const SERVER_ID = 'b41d8e2c-5f77-4a90-8c31-2ad6f9c14b05';
const SLUG = 'calm-path-therapy';
const CAL_URL = 'https://cal.com/calm-path/intro';
const PAYMENT_INTENT_ID = 'pi_local_deploy_e2e';
const WEBHOOK_SECRET = 'whsec_local_deploy_secret';
const WORKER_SECRET = 'w'.repeat(48);
const AGENT_SECRET = 'deploy-agent-secret';

let db: FakePostgrest;
let workerServer: Server;
let artifactServer: Server;
let agentServer: Server;
let staticServer: Server;
let scratch = '';
let sitesRoot = '';
let artifactsRoot = '';
let staticBaseUrl = '';
const workerErrors: string[] = [];
/** Every slug the stand-in agent extracted, so a silent no-op is visible. */
const agentDeploys: Array<{ slug: string; sha256: string }> = [];

// ── The approved preview, exactly as the funnel stores it ────────────────────
// `claim.ts` runs `injectCalComPreviewDemo` before saving, so what the build
// starts from carries the blurred tease and no cal.com request anywhere.
function approvedPreviewFiles() {
  const pages = injectCalComPreviewDemo({
    'src/pages/index.astro': '<main><h1>Calm Path Therapy</h1></main>',
    'src/pages/book.astro':
      '<main><div class="book-page__calendar">Replace with your booking embed</div></main>',
  });
  return [
    {
      path: 'package.json',
      content: JSON.stringify({ name: SLUG, private: true }, null, 2),
      type: 'file',
    },
    {
      path: 'src/pages/index.astro',
      content: pages['src/pages/index.astro']!,
      type: 'file',
    },
    {
      path: 'src/pages/book.astro',
      content: pages['src/pages/book.astro']!,
      type: 'file',
    },
  ];
}

function seed(): void {
  db.seed('hosting_servers', [
    {
      id: SERVER_ID,
      name: 'local-dev',
      status: 'active',
      ipv4: '127.0.0.1',
      deploy_agent_url: `http://127.0.0.1:${
        (agentServer.address() as AddressInfo).port
      }`,
      deploy_agent_secret_ref: 'deploy_agent_shared_secret_local_dev',
    },
  ]);
  db.seed('workspaces', [
    {
      id: WORKSPACE_ID,
      slug: SLUG,
      project_state: ProjectState.PREVIEW_READY,
      billing_currency: 'eur',
      final_value_minor: 79_900,
      deposit_payment_intent_id: null,
      deposit_status: 'sent',
      outstanding_payment: true,
      cal_com_url: CAL_URL,
      hosting_server_id: SERVER_ID,
      deploy_status: 'pending',
    },
  ]);
  db.seed('flowstarter_project_artifacts', [
    {
      workspace_id: WORKSPACE_ID,
      intake_payload: {
        projectId: WORKSPACE_ID,
        business: {
          name: 'Calm Path Therapy',
          niche: 'Therapy practice',
          location: 'Cluj-Napoca, Romania',
        },
        socialMedia: [],
        locale: 'en-RO',
        submittedAt: '2026-08-31T10:00:00.000Z',
        consent: {
          publicProfileAnalysis: true,
          acceptedAt: '2026-08-31T10:00:00.000Z',
        },
      },
      brand_config: { schemaVersion: '1.0' },
      preview_manifest: { files: approvedPreviewFiles() },
    },
  ]);
  // The in-depth brief, already complete. Since the flow gained a brief step
  // the worker refuses to claim a FULL_SITE_BUILD until `ready_at` is set or
  // an operator has overridden it, so a deposit alone no longer starts a
  // build. The waiting half of that rule is proved directly in
  // `apps/build-worker/test/job-store.test.ts`; this chain is about what
  // happens once the client has answered.
  db.seed('workspace_briefs', [
    {
      workspace_id: WORKSPACE_ID,
      offer:
        'One to one therapy for adults, in person in Cluj and online, in fifty minute sessions.',
      projects: [],
      no_projects: true,
      ready_at: '2026-08-31T11:00:00.000Z',
      override_at: null,
    },
  ]);
}

function signedDepositEvent(eventId: string): {
  payload: string;
  signature: string;
} {
  const stripe = new Stripe('sk_test_local_deploy');
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    // Stripe always sends this, and the event ledger orders on it.
    created: Math.floor(Date.parse('2026-08-11T12:00:00.000Z') / 1000),
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: PAYMENT_INTENT_ID,
        object: 'payment_intent',
        status: 'succeeded',
        currency: 'eur',
        // 20% of final_value_minor, which is what the server-owned quote says.
        amount_received: 15_980,
        metadata: { kind: 'flowstarter_deposit', workspaceId: WORKSPACE_ID },
      },
    },
  });
  return {
    payload,
    signature: stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    }),
  };
}

async function waitForJobToSettle(
  timeoutMs = 90_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = db.find('flowstarter_agent_jobs', {
      workspace_id: WORKSPACE_ID,
    });
    const settled =
      job && job['status'] !== 'queued' && job['status'] !== 'running';
    // The worker marks the job row succeeded and *then* moves the workspace
    // out of AGENTS_WORKING in a second round trip (JobStore.markHumanQa --
    // PostgREST gives it no cross-table transaction). Returning on the job
    // row alone lets a caller read the workspace inside that window, which is
    // how this suite failed on CI with project_state still AGENTS_WORKING.
    // Wait for both writes, the way any real consumer of the ledger has to.
    const workspaceMoved =
      db.find('workspaces', { id: WORKSPACE_ID })?.['project_state'] !==
      ProjectState.AGENTS_WORKING;
    if (settled && (job['status'] !== 'succeeded' || workspaceMoved))
      return job;
    if (Date.now() > deadline) {
      throw new Error(
        `build did not settle in ${timeoutMs}ms; last status ${String(
          job?.['status']
        )}` +
          (workerErrors.length
            ? `; worker errors: ${workerErrors.join(' | ')}`
            : '')
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The stand-in deploy-agent: the same contract `HttpDeployAgentClient` speaks,
 * the same `tar -xzf` into `<sitesRoot>/<slug>`, the same JSON answer.
 */
function startStandInAgent(): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, payload: unknown) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };
      if (req.headers.authorization !== `Bearer ${AGENT_SECRET}`) {
        return send(401, { error: 'unauthorized' });
      }
      const match = /^\/sites\/([^/]+)\/deploy$/.exec(url.pathname);
      if (!match || req.method !== 'POST')
        return send(404, { error: 'not found' });
      const slug = match[1] as string;

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        artifact_url: string;
        artifact_sha256?: string | null;
      };

      const fetched = await fetch(body.artifact_url);
      if (!fetched.ok) return send(502, { error: `fetch ${fetched.status}` });
      const bytes = Buffer.from(await fetched.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (body.artifact_sha256 && body.artifact_sha256 !== sha256) {
        return send(400, { error: 'sha256 mismatch' });
      }

      const tarball = join(scratch, `${slug}-${Date.now()}.tar.gz`);
      await writeFile(tarball, bytes);
      const siteDir = join(sitesRoot, slug);
      await rm(siteDir, { recursive: true, force: true });
      await mkdir(siteDir, { recursive: true });
      await execFileAsync('tar', ['-xzf', tarball, '-C', siteDir]);
      agentDeploys.push({ slug, sha256 });
      return send(200, {
        ok: true,
        slug,
        sha256,
        sizeBytes: bytes.length,
        siteDir,
      });
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done(server))
  );
}

/** What the real agent's DEPLOY_AGENT_STATIC_PORT server does: `/{slug}/…`. */
function startStaticServer(): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const slug = segments[0];
      if (!slug) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const siteDir = resolve(sitesRoot, slug);
      const rest = segments.slice(1).join('/');
      for (const candidate of rest
        ? [rest, `${rest}/index.html`]
        : ['index.html']) {
        const target = resolve(siteDir, candidate);
        if (!target.startsWith(`${siteDir}/`)) continue;
        try {
          const body = await readFile(target);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(body);
        } catch {
          /* try the next candidate */
        }
      }
      res.writeHead(404);
      res.end('Not found');
    })();
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done(server))
  );
}

beforeAll(async () => {
  // Under a pre-commit hook git exports GIT_DIR/GIT_INDEX_FILE pointing at the
  // parent repository, which would silently redirect the scratch repo's git.
  for (const key of [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_WORK_TREE',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
    'GIT_QUARANTINE_PATH',
  ]) {
    delete process.env[key];
  }

  db = await startFakePostgrest();
  hoisted.restUrl = db.url;

  scratch = await mkdtemp(join(tmpdir(), 'flowstarter-local-deploy-'));
  sitesRoot = join(scratch, 'sites');
  artifactsRoot = join(scratch, 'artifacts');
  const repositoryRoot = join(scratch, 'repository');
  const worktreesRoot = join(scratch, 'worktrees');
  await mkdir(sitesRoot, { recursive: true });

  process.env.GIT_AUTHOR_NAME = 'Flowstarter Build Agent';
  process.env.GIT_AUTHOR_EMAIL = 'build-agent@flowstarter.test';
  process.env.GIT_COMMITTER_NAME = process.env.GIT_AUTHOR_NAME;
  process.env.GIT_COMMITTER_EMAIL = process.env.GIT_AUTHOR_EMAIL;

  await execFileAsync('git', ['init', '-b', 'main', repositoryRoot]);
  await writeFile(join(repositoryRoot, 'README.md'), '# sites\n', 'utf8');
  await execFileAsync('git', ['add', '--all'], { cwd: repositoryRoot });
  await execFileAsync('git', ['commit', '--message', 'chore: seed'], {
    cwd: repositoryRoot,
  });

  agentServer = await startStandInAgent();
  staticServer = await startStaticServer();
  staticBaseUrl = `http://127.0.0.1:${
    (staticServer.address() as AddressInfo).port
  }`;

  // The worker serves its own artifacts; the agent fetches them from here.
  const artifacts = new ArtifactStore({ root: artifactsRoot, baseUrl: '' });
  artifactServer = createServer((req, res) => {
    void (async () => {
      const token = /^\/artifacts\/(.+)\.tar\.gz$/.exec(
        new URL(req.url ?? '/', 'http://localhost').pathname
      )?.[1];
      const bytes = token ? await artifacts.read(token) : null;
      if (!bytes) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(bytes);
    })();
  });
  await new Promise<void>((done) =>
    artifactServer.listen(0, '127.0.0.1', done)
  );
  const artifactBaseUrl = `http://127.0.0.1:${
    (artifactServer.address() as AddressInfo).port
  }`;

  process.env.STRIPE_SECRET_KEY = 'sk_test_local_deploy';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FLOWSTARTER_BUILD_WORKER_SECRET = WORKER_SECRET;
  process.env.DEPLOY_AGENT_SHARED_SECRET = AGENT_SECRET;
  process.env.FLOWSTARTER_LOCAL_SITE_BASE_URL = staticBaseUrl;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.DEPLOY_AGENT_DRY_RUN;

  const store = new SupabaseFullSiteBuildJobStore(
    createClient(db.url, 'test-service-role-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    { maxAttempts: 3 }
  );
  const worktrees = new SafeGitWorktreeManager({
    repositoryRoot,
    worktreesRoot,
    baseRef: 'main',
  });

  // The one seam a test cannot reach. Same contract as `createStubFullSiteAgent`.
  const agents = {
    buildFullSite: async (input: { workspaceRoot: string }) => {
      await writeFile(
        join(input.workspaceRoot, 'flowstarter-build.json'),
        JSON.stringify({ mode: 'local-stub' }),
        'utf8'
      );
      return { summary: 'stub', changedPaths: ['flowstarter-build.json'] };
    },
  } as unknown as PiSdkFlowstarterAgents;

  // Stands in for `astro build`: a real subprocess turning the personalized
  // pages into the dist/ tree the publisher packages.
  const validator = new CommandSiteValidator({
    commands: [
      {
        bin: 'node',
        args: [
          '-e',
          "const fs=require('node:fs');fs.mkdirSync('dist/book',{recursive:true});" +
            "fs.writeFileSync('dist/index.html',fs.readFileSync('src/pages/index.astro','utf8'));" +
            "fs.writeFileSync('dist/book/index.html',fs.readFileSync('src/pages/book.astro','utf8'));",
        ],
      },
    ],
    timeoutMs: 60_000,
  });

  const publisher = new LocalSitePublisher({
    store: new ArtifactStore({ root: artifactsRoot, baseUrl: artifactBaseUrl }),
    flowstarterMainUrl: 'http://internal.test',
    sharedSecret: WORKER_SECRET,
    outputDir: 'dist',
    stagingUrlTemplate: 'http://localhost:8788/{projectId}/',
    // The route handler is the real one; calling it directly is how a Next
    // route is reachable from a test without booting the server.
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      internalDeploy(
        new NextRequest(String(input), {
          method: 'POST',
          body: String(init?.body ?? ''),
          headers: init?.headers as HeadersInit,
        })
      )) as typeof globalThis.fetch,
  });

  const worker = new FullSiteBuildWorker(
    store,
    worktrees,
    agents,
    validator,
    publisher
  );
  const queue = new BuildQueue({
    concurrency: 1,
    queueLimit: 8,
    run: (jobId) => worker.run(jobId),
    onError: (_jobId, error) =>
      workerErrors.push(error instanceof Error ? error.message : String(error)),
  });

  workerServer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const result = handleRequest(
        {
          method: req.method ?? 'GET',
          path: new URL(req.url ?? '/', 'http://localhost').pathname,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        },
        { sharedSecret: WORKER_SECRET, queue }
      );
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    })();
  });
  await new Promise<void>((done) => workerServer.listen(0, '127.0.0.1', done));
  process.env.FLOWSTARTER_BUILD_WORKER_URL = `http://127.0.0.1:${
    (workerServer.address() as AddressInfo).port
  }`;

  seed();
}, 120_000);

afterAll(async () => {
  for (const server of [
    workerServer,
    artifactServer,
    agentServer,
    staticServer,
  ]) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  await db.close();
  await rm(scratch, { recursive: true, force: true });
});

describe('deposit -> local build -> deploy -> a site that opens', () => {
  it('carries a signed deposit all the way to servable HTML with the tenant calendar', async () => {
    const { payload, signature } = signedDepositEvent('evt_local_deploy_1');
    const response = await stripeWebhook(
      new NextRequest('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: payload,
        headers: { 'stripe-signature': signature },
      })
    );
    expect(response.status).toBe(200);

    const job = await waitForJobToSettle();

    // ── Ledger ────────────────────────────────────────────────────────────
    expect(job['status']).toBe('succeeded');
    expect(job['attempt_count']).toBe(1);
    // No PR exists in local mode; the artifact URL is what the build produced.
    expect(String(job['pull_request_url'])).toMatch(
      /\/artifacts\/.+\.tar\.gz$/
    );
    expect(job['payload']).toMatchObject({
      trigger: 'deposit_paid',
      source: 'payment_intent',
      stagingUrl: `${staticBaseUrl}/${SLUG}/`,
    });

    // ── Workspace lifecycle, both halves ──────────────────────────────────
    const workspace = db.find('workspaces', { id: WORKSPACE_ID });
    expect(workspace?.['project_state']).toBe(ProjectState.HUMAN_QA);
    expect(workspace?.['deposit_status']).toBe('paid');
    expect(workspace?.['deploy_status']).toBe('live');
    expect(workspace?.['last_deploy_id']).toBeTruthy();

    // ── The deployments ledger, not a side channel ────────────────────────
    const deployment = db.find('deployments', { workspace_id: WORKSPACE_ID });
    expect(deployment).toMatchObject({ version: 1, status: 'live' });
    expect(String(deployment?.['artifact_sha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(deployment?.['artifact_bytes'])).toBeGreaterThan(0);

    // ── The agent really extracted a real tarball ─────────────────────────
    expect(agentDeploys).toEqual([
      { slug: SLUG, sha256: deployment?.['artifact_sha256'] },
    ]);
    expect(
      await readFile(join(sitesRoot, SLUG, 'index.html'), 'utf8')
    ).toContain('Calm Path Therapy');

    // ── And it opens over HTTP ────────────────────────────────────────────
    const served = await fetch(`${staticBaseUrl}/${SLUG}/`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('Calm Path Therapy');
  }, 120_000);

  it('serves the tenant live Cal embed, not the blurred preview demo', async () => {
    const booking = await fetch(`${staticBaseUrl}/${SLUG}/book/`);
    expect(booking.status).toBe(200);
    const html = await booking.text();

    expect(html).toContain('data-flowstarter-cal-embed="true"');
    expect(html).toContain('cal.com/calm-path/intro/embed');
    // The tease the funnel published is gone, not merely hidden behind it.
    expect(html).not.toContain('data-flowstarter-cal-preview');
    expect((html.match(/<iframe/g) ?? []).length).toBe(1);
  });

  it('refuses an unauthenticated deploy callback', async () => {
    const unauthorized = await internalDeploy(
      new NextRequest('http://internal.test/api/internal/build/deploy', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          artifactUrl: 'https://cdn.example/evil.tar.gz',
        }),
        headers: { authorization: 'Bearer not-the-secret' },
      })
    );
    expect(unauthorized.status).toBe(401);
    // Nothing moved: still one deployment, still the same extracted bytes.
    expect(db.rows('deployments')).toHaveLength(1);
  });

  it('refuses an artifact URL that is neither https nor loopback', async () => {
    const rejected = await internalDeploy(
      new NextRequest('http://internal.test/api/internal/build/deploy', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          artifactUrl: 'http://attacker.example/site.tar.gz',
        }),
        headers: { authorization: `Bearer ${WORKER_SECRET}` },
      })
    );
    expect(rejected.status).toBe(400);
    expect(db.rows('deployments')).toHaveLength(1);
  });
});
