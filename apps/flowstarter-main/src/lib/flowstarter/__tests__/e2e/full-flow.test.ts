/**
 * End-to-end: a paid deposit invoice becomes a reviewed site awaiting human QA.
 *
 * This drives the real chain, not a mock of it:
 *
 *   real Stripe-signed webhook payload
 *     -> real POST handler in app/api/webhooks/stripe/route.ts
 *     -> real constructEvent signature verification
 *     -> real enqueueFullBuildFromDepositInvoice
 *     -> real supabase-js over HTTP to an in-memory PostgREST
 *     -> real fetch dispatch to a real running build-worker HTTP server
 *     -> real bearer auth + BuildQueue
 *     -> real SupabaseFullSiteBuildJobStore compare-and-set claim
 *     -> real SafeGitWorktreeManager (real `git worktree add` on a real repo)
 *     -> real materializeScaffold of the approved preview files
 *     -> [stub] the Pi coding session
 *     -> real CommandSiteValidator (spawns a real build, checks real output)
 *     -> real `git commit` under the real commit-message policy
 *     -> real `git push` to a real bare remote
 *     -> [stub] github.com's pull-request REST call
 *     -> real ledger + workspace state transitions
 *
 * Two boundaries are stubbed because they cannot be reached from a test: the
 * LLM provider and github.com. Everything between them is the shipping code.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import {
  FullSiteBuildWorker,
  ProjectState,
  SafeGitWorktreeManager,
  type PiSdkFlowstarterAgents,
} from '@flowstarter/agentic-codegen';
import { createClient } from '@supabase/supabase-js';
import { handleRequest } from '@flowstarter/build-worker/src/http';
import { SupabaseFullSiteBuildJobStore } from '@flowstarter/build-worker/src/job-store';
import { GitHubPullRequestPublisher } from '@flowstarter/build-worker/src/pull-requests';
import { BuildQueue } from '@flowstarter/build-worker/src/queue';
import { CommandSiteValidator } from '@flowstarter/build-worker/src/validator';
import { startFakeGitHub, type FakeGitHub } from './fake-github';
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

// vi.mock is hoisted above this import, so the route resolves the fake client.
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const DEPOSIT_INVOICE_ID = 'in_deposit_e2e_1';
const WEBHOOK_SECRET = 'whsec_e2e_test_secret';
const WORKER_SECRET = 'w'.repeat(48);
const BRANCH = `client/flowstarter-${WORKSPACE_ID}`;

let db: FakePostgrest;
let github: FakeGitHub;
let workerServer: Server;
let repositoryRoot: string;
let worktreesRoot: string;
let bareRemote: string;
let scratch: string;
/** Files the stubbed Pi session wrote, so we can assert the agent really ran. */
const agentRuns: string[] = [];
/** Anything the worker threw, so a stalled build reports its cause. */
const workerErrors: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout;
}

/** The approved preview the client paid a deposit against. */
function approvedPreviewFiles() {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        { name: 'calm-path-therapy', private: true, version: '0.0.0' },
        null,
        2
      ),
      type: 'file',
    },
    {
      path: 'src/content/site.md',
      content: '# Calm Path Therapy\n\nApproved preview copy.\n',
      type: 'file',
    },
  ];
}

function seedWorkspace(): void {
  db.seed('workspaces', [
    {
      id: WORKSPACE_ID,
      project_state: ProjectState.PREVIEW_READY,
      billing_currency: 'eur',
      final_value_minor: 79_900,
      setup_fee: 799,
      deposit_invoice_id: DEPOSIT_INVOICE_ID,
      deposit_payment_intent_id: null,
      deposit_status: 'sent',
      outstanding_payment: true,
    },
  ]);
  // The artifact row the build reads its intake, brand and approved preview
  // from. Nothing in the app writes this yet — seeding it here is exactly the
  // production gap this E2E documents.
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
        submittedAt: '2026-08-11T10:00:00.000Z',
        consent: {
          publicProfileAnalysis: true,
          acceptedAt: '2026-08-11T10:00:00.000Z',
        },
      },
      brand_config: { schemaVersion: '1.0' },
      preview_manifest: {
        files: approvedPreviewFiles(),
        requiredIntegrations: ['cal.com', 'newsletter'],
      },
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
      ready_at: '2026-08-11T11:00:00.000Z',
      override_at: null,
    },
  ]);
}

function signedInvoiceEvent(eventId: string): {
  payload: string;
  signature: string;
} {
  const stripe = new Stripe('sk_test_e2e');
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    // Stripe always sends this, and the event ledger orders on it.
    created: Math.floor(Date.parse('2026-08-11T12:00:00.000Z') / 1000),
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: DEPOSIT_INVOICE_ID,
        object: 'invoice',
        currency: 'eur',
        amount_paid: 15_980,
        metadata: { invoiceType: 'deposit', workspaceId: WORKSPACE_ID },
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

async function deliver(eventId: string): Promise<Response> {
  const { payload, signature } = signedInvoiceEvent(eventId);
  return stripeWebhook(
    new NextRequest('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      body: payload,
      headers: { 'stripe-signature': signature },
    })
  );
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  // This suite drives real `git` subprocesses. Under a pre-commit hook git
  // exports GIT_DIR/GIT_INDEX_FILE pointing at the parent repository, which
  // silently redirects every git call in the test's scratch repos. Drop them.
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
  github = await startFakeGitHub();
  hoisted.restUrl = db.url;

  scratch = await mkdtemp(join(tmpdir(), 'flowstarter-e2e-'));
  repositoryRoot = join(scratch, 'repository');
  worktreesRoot = join(scratch, 'worktrees');
  bareRemote = join(scratch, 'remote.git');

  // `git commit` inside SafeGitWorktreeManager inherits this process env, the
  // same way the worker sets it at boot.
  process.env.GIT_AUTHOR_NAME = 'Flowstarter Build Agent';
  process.env.GIT_AUTHOR_EMAIL = 'build-agent@flowstarter.test';
  process.env.GIT_COMMITTER_NAME = process.env.GIT_AUTHOR_NAME;
  process.env.GIT_COMMITTER_EMAIL = process.env.GIT_AUTHOR_EMAIL;

  await execFileAsync('git', ['init', '-b', 'main', repositoryRoot]);
  await writeFile(join(repositoryRoot, 'README.md'), '# sites\n', 'utf8');
  await git(repositoryRoot, ['add', '--all']);
  await git(repositoryRoot, ['commit', '--message', 'chore: seed sites repo']);
  await execFileAsync('git', ['init', '--bare', bareRemote]);
  await git(repositoryRoot, ['remote', 'add', 'origin', bareRemote]);

  // ── The build worker, assembled from its real parts ──────────────────────
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

  // The one seam that cannot reach a real provider. It behaves like the real
  // full-site session: it may only touch its own workspace root.
  const agents = {
    buildFullSite: async (input: {
      workspaceRoot: string;
      requiredIntegrations: string[];
    }) => {
      agentRuns.push(input.workspaceRoot);
      const approved = await readFile(
        join(input.workspaceRoot, 'src/content/site.md'),
        'utf8'
      );
      if (!approved.includes('Approved preview copy')) {
        throw new Error('agent did not receive the approved preview');
      }
      await writeFile(
        join(input.workspaceRoot, 'src/content/about.md'),
        `# About\n\nIntegrations: ${input.requiredIntegrations.join(', ')}\n`,
        'utf8'
      ).catch(async () => {
        await execFileAsync('mkdir', [
          '-p',
          join(input.workspaceRoot, 'src/content'),
        ]);
      });
      return {
        summary: 'Full site built',
        changedPaths: ['src/content/about.md'],
      };
    },
  } as unknown as PiSdkFlowstarterAgents;

  const validator = new CommandSiteValidator({
    commands: [
      {
        bin: 'node',
        args: [
          '-e',
          "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<h1>Calm Path Therapy</h1>')",
        ],
      },
    ],
    timeoutMs: 60_000,
  });

  const pullRequests = new GitHubPullRequestPublisher({
    apiBaseUrl: github.url,
    owner: 'flowstarter',
    repo: 'sites',
    token: 'ghp_e2e_token',
    remote: 'origin',
    baseRef: 'main',
    stagingUrlTemplate: 'https://{projectId}.staging.flowstarter.test',
  });

  const worker = new FullSiteBuildWorker(
    store,
    worktrees,
    agents,
    validator,
    pullRequests
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
      const text = JSON.stringify(result.body);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(text);
    })();
  });
  await new Promise<void>((resolve) =>
    workerServer.listen(0, '127.0.0.1', resolve)
  );
  const { port } = workerServer.address() as AddressInfo;

  process.env.STRIPE_SECRET_KEY = 'sk_test_e2e';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FLOWSTARTER_BUILD_WORKER_URL = `http://127.0.0.1:${port}`;
  process.env.FLOWSTARTER_BUILD_WORKER_SECRET = WORKER_SECRET;

  seedWorkspace();
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => workerServer.close(() => resolve()));
  await db.close();
  await github.close();
  await rm(scratch, { recursive: true, force: true });
});

describe('deposit invoice -> built site awaiting human QA', () => {
  it('carries a signed Stripe deposit all the way to an open pull request', async () => {
    const response = await deliver('evt_e2e_1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    const job = await waitForJobToSettle();

    // ── Ledger ────────────────────────────────────────────────────────────
    expect(job['status']).toBe('succeeded');
    expect(job['kind']).toBe('FULL_SITE_BUILD');
    expect(job['stripe_event_id']).toBe('evt_e2e_1');
    expect(job['attempt_count']).toBe(1);
    expect(job['worktree_branch']).toBe(BRANCH);
    expect(job['pull_request_url']).toMatch(
      /^https:\/\/github\.com\/flowstarter\/sites\/pull\/\d+$/
    );
    // Provenance from enqueue time survives alongside the build result, so a
    // shipped site can still be traced back to the payment that bought it.
    expect(job['payload']).toMatchObject({
      trigger: 'deposit_paid',
      source: 'deposit_invoice',
      depositPercent: 20,
      balancePercent: 80,
      stagingUrl: `https://${WORKSPACE_ID}.staging.flowstarter.test`,
      pullRequestUrl: job['pull_request_url'],
    });
    expect(
      String((job['payload'] as Record<string, unknown>)['commitSha'])
    ).toMatch(/^[0-9a-f]{40}$/);

    // ── Workspace lifecycle ───────────────────────────────────────────────
    const workspace = db.find('workspaces', { id: WORKSPACE_ID });
    expect(workspace?.['project_state']).toBe(ProjectState.HUMAN_QA);
    expect(workspace?.['deposit_status']).toBe('paid');
    expect(workspace?.['outstanding_payment']).toBe(false);
    // The invoice path must never claim the Checkout path's unique column.
    expect(workspace?.['deposit_payment_intent_id']).toBeNull();

    // ── The agent really ran, inside its own worktree ─────────────────────
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]).toContain(`generated-sites/${WORKSPACE_ID}`);
    expect(agentRuns[0]).toContain('worktrees');

    // ── A real commit on a real branch in the real bare remote ────────────
    const log = await git(bareRemote, ['log', '--oneline', BRANCH]);
    expect(log).toContain(`build: initialize Flowstarter site ${WORKSPACE_ID}`);

    const committedPreview = await git(bareRemote, [
      'show',
      `${BRANCH}:generated-sites/${WORKSPACE_ID}/src/content/site.md`,
    ]);
    expect(committedPreview).toContain('Approved preview copy');

    // The agent's own output and the validated build output are both in the
    // commit the reviewer will see.
    const committedAbout = await git(bareRemote, [
      'show',
      `${BRANCH}:generated-sites/${WORKSPACE_ID}/src/content/about.md`,
    ]);
    expect(committedAbout).toContain('cal.com, newsletter');
    const committedBuild = await git(bareRemote, [
      'show',
      `${BRANCH}:generated-sites/${WORKSPACE_ID}/dist/index.html`,
    ]);
    expect(committedBuild).toContain('Calm Path Therapy');

    // ── The pull request that gates HUMAN_QA ──────────────────────────────
    const created = github.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/pulls')
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({
      head: BRANCH,
      base: 'main',
      draft: true,
    });
    expect(created[0]?.authorization).toBe('Bearer ghp_e2e_token');
  }, 120_000);

  it('treats a Stripe redelivery of the same deposit as a no-op', async () => {
    const before = db.rows('flowstarter_agent_jobs').length;
    const pullsBefore = github.requests.length;

    const response = await deliver('evt_e2e_1');
    expect(response.status).toBe(200);

    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(before);
    expect(github.requests).toHaveLength(pullsBefore);
    expect(db.find('workspaces', { id: WORKSPACE_ID })?.['project_state']).toBe(
      ProjectState.HUMAN_QA
    );
  }, 30_000);

  it('rejects an unsigned or tampered webhook before any state moves', async () => {
    const { payload } = signedInvoiceEvent('evt_e2e_forged');
    const response = await stripeWebhook(
      new NextRequest('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        body: payload,
        headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      })
    );

    expect(response.status).toBe(401);
    expect(db.rows('flowstarter_agent_jobs')).toHaveLength(1);
  });
});
