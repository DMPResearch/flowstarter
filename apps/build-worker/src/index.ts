/**
 * Flowstarter build worker.
 *
 * The private Pi worker named in `docs/FLOWSTARTER_AGENT_ARCHITECTURE.md`.
 * It closes the DEPOSIT_PAID -> AGENTS_WORKING -> HUMAN_QA leg of the
 * lifecycle: flowstarter-main enqueues one FULL_SITE_BUILD row per paid
 * deposit and dispatches it here, and this service drives
 * `FullSiteBuildWorker` — isolated git worktree, bounded Pi full-site session,
 * trusted validation, atomic commit, internal PR.
 *
 * It runs on the Hetzner compute host, never on Netlify: builds take minutes
 * and need a real filesystem and git.
 *
 *   POST /jobs/full-site   { "jobId": "<uuid>" }   -> 202, build runs detached
 *   GET  /health                                   -> liveness + queue depth
 *
 * Auth: `Authorization: Bearer <FLOWSTARTER_BUILD_WORKER_SECRET>`, the same
 * secret flowstarter-main signs its dispatch with.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createClient } from '@supabase/supabase-js';
import {
  FullSiteBuildWorker,
  PiSdkFlowstarterAgents,
  SafeGitWorktreeManager,
  type PullRequestPublisher,
} from '@flowstarter/agentic-codegen';
import { ArtifactStore, artifactTokenFromPath } from './artifacts';
import { ConfigError, loadConfig } from './config';
import { handleRequest, VERSION } from './http';
import {
  attachMachineLog,
  detachMachineLog,
  machineLog,
  machineLogWriter,
  runWithJob,
} from './job-context';
import { SupabaseFullSiteBuildJobStore } from './job-store';
import { LocalSitePublisher } from './local-publisher';
import { ensureLocalSitesRepository } from './local-repo';
import { GitHubPullRequestPublisher } from './pull-requests';
import { BuildQueue } from './queue';
import { BuildReconciler } from './reconcile';
import { createStubFullSiteAgent } from './stub-agent';
import { CommandSiteValidator, NoopSiteValidator } from './validator';

const MAX_BODY_BYTES = 64 * 1024;

function loadConfigOrExit(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch (error) {
    const detail =
      error instanceof ConfigError || error instanceof Error
        ? error.message
        : 'unknown configuration failure';
    console.error(`[build-worker] refusing to start: ${detail}`);
    process.exit(1);
  }
}

const config = loadConfigOrExit();

// SafeGitWorktreeManager.commit() shells out to `git commit`, which needs an
// identity. Setting it on the process env keeps it out of the repository's
// own config, so a worktree can never inherit a stale author.
process.env.GIT_AUTHOR_NAME ||= 'Flowstarter Build Agent';
process.env.GIT_AUTHOR_EMAIL ||= 'build-agent@flowstarter.net';
process.env.GIT_COMMITTER_NAME ||= process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL ||= process.env.GIT_AUTHOR_EMAIL;

const supabase = createClient(
  config.supabaseUrl,
  config.supabaseServiceRoleKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const store = new SupabaseFullSiteBuildJobStore(supabase, {
  maxAttempts: config.maxAttempts,
});
const worktrees = new SafeGitWorktreeManager({
  repositoryRoot: config.git.repositoryRoot,
  worktreesRoot: config.git.worktreesRoot,
  baseRef: config.git.baseRef,
});
const agents = config.local?.stubAgent
  ? createStubFullSiteAgent()
  : new PiSdkFlowstarterAgents({
      provider: config.pi.provider,
      modelId: config.pi.modelId,
      apiKey: config.pi.apiKey,
      thinkingLevel: config.pi.thinkingLevel,
      timeoutMs: config.pi.timeoutMs,
    });
/**
 * Every machine line goes to both places: the console an operator tails, and
 * the build's own record, which is the only one a client-facing board can read.
 */
function report(message: string): void {
  console.info(`[build-worker] ${message}`);
  machineLog(message);
}

// The validator choice is a rule, not a side effect of the stub agent:
// SITE_REBUILD and CHANGE_REQUEST_BUILD never call the agent at all, and
// FULL_SITE_BUILD may run with a stubbed one, but every job kind still has
// to pass a real `pnpm install && pnpm run build` before its output is
// packaged or PR'd. Only `config.skipValidation` — refused by config.ts
// outside development — may swap in the noop validator.
const validator = config.skipValidation
  ? new NoopSiteValidator()
  : new CommandSiteValidator({
      commands: config.validateCommands,
      timeoutMs: config.buildTimeoutMs,
      // Docker isolation is opt-in per host (it needs a daemon), and config.ts
      // has already refused to start if it was asked for with commands the
      // image cannot run.
      isolation: config.validateDocker
        ? { mode: 'docker', docker: config.validateDocker }
        : { mode: 'native' },
      onProgress: report,
      onOutput: (command, lines) => {
        report(`Output of ${command}:`);
        for (const line of lines) report(`  ${line}`);
      },
    });

const artifacts = config.local
  ? new ArtifactStore({
      root: config.local.artifactsRoot,
      baseUrl: config.local.artifactBaseUrl,
    })
  : null;

const pullRequests: PullRequestPublisher =
  config.local && artifacts
    ? new LocalSitePublisher({
        store: artifacts,
        flowstarterMainUrl: config.local.flowstarterMainUrl,
        sharedSecret: config.sharedSecret,
        outputDir: config.local.outputDir,
        stagingUrlTemplate: config.stagingUrlTemplate,
        onProgress: report,
      })
    : new GitHubPullRequestPublisher({
        // Non-null by construction: config.github is only null in local mode,
        // which the branch above already took.
        apiBaseUrl: config.github!.apiBaseUrl,
        owner: config.github!.owner,
        repo: config.github!.repo,
        token: config.github!.token,
        remote: config.git.remote,
        baseRef: config.git.baseRef,
        stagingUrlTemplate: config.stagingUrlTemplate,
      });

const worker = new FullSiteBuildWorker(
  store,
  worktrees,
  agents,
  validator,
  pullRequests,
  // The worker owns the sink; this process owns its registration, so the
  // lifecycle lines it writes after `run()` returns still reach the record.
  { onJobLog: (jobId, log) => attachMachineLog(jobId, log) },
);

const queue = new BuildQueue({
  concurrency: config.concurrency,
  queueLimit: config.queueLimit,
  run: (jobId) =>
    runWithJob(jobId, async () => {
      report(`job ${jobId} started`);
      try {
        await worker.run(jobId);
        report(`job ${jobId} finished`);
      } catch (error) {
        // Recorded here, where the job's log is still attached. The console
        // half of this line is `onError` below, which the queue always calls.
        machineLog(
          `job ${jobId} failed: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
        throw error;
      } finally {
        await machineLogWriter(jobId)?.flush();
        detachMachineLog(jobId);
      }
    }),
  // FullSiteBuildWorker has already recorded the failure on the ledger and
  // rethrown; this is the operator-facing log, not the client-facing state.
  onError: (jobId, error) =>
    console.error(
      `[build-worker] job ${jobId} failed:`,
      error instanceof Error ? error.message : error,
    ),
});

/**
 * The durable queue, beside the in-process one.
 *
 * Started after the server is listening rather than before: the first sweep
 * may enqueue a build, and a build that starts before this process can answer
 * /health is a build an operator cannot see.
 */
const reconciler = new BuildReconciler({
  store,
  enqueue: (jobId) => queue.enqueue(jobId),
  intervalMs: config.pollIntervalMs,
  limit: config.pollLimit,
  onReport: (message) => console.info(`[build-worker] ${message}`),
});

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    // Local mode only. The deploy-agent fetches the artifact it is told to
    // extract and has no bearer token for us, so this route is open — which is
    // safe only because the token in the file name is 128 bits of CSPRNG.
    const token = artifacts ? artifactTokenFromPath(path) : null;
    if (token && req.method === 'GET') {
      const bytes = await artifacts!.read(token);
      if (!bytes) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': bytes.length,
        'cache-control': 'no-store',
      });
      res.end(bytes);
      return;
    }

    const body = await readBody(req);
    const result =
      body === null
        ? { status: 413, body: { error: 'request body is too large' } }
        : handleRequest(
            {
              method: req.method ?? 'GET',
              path,
              authorization: req.headers.authorization,
              body,
            },
            { sharedSecret: config.sharedSecret, queue },
          );
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  })().catch((error: unknown) => {
    console.error('[build-worker] request failed:', error);
    if (!res.headersSent)
      res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  });
});

async function start(): Promise<void> {
  if (config.local) {
    const { created } = await ensureLocalSitesRepository(
      config.git.repositoryRoot,
      config.git.baseRef,
    );
    if (created) {
      console.info(
        `[build-worker] initialised a local sites repository at ${config.git.repositoryRoot}`,
      );
    }
  }
  server.listen(config.port, config.hostname, () => {
    // Startup reconciliation: everything dispatched while this process was
    // down, and every job whose client finished their brief in the meantime.
    reconciler.start();
    const target = config.local
      ? `local deploy via ${config.local.flowstarterMainUrl}` +
        (config.local.stubAgent ? ', stub agent' : '')
      : `repo ${config.github?.owner}/${config.github?.repo}`;
    const validation = config.skipValidation
      ? 'noop (FLOWSTARTER_BUILD_SKIP_VALIDATION)'
      : config.validateDocker
        ? `docker ${config.validateDocker.image}`
        : 'native';
    console.info(
      `[build-worker] v${VERSION} listening on ${config.hostname}:${config.port} ` +
        `(mode ${config.publishMode}, model ${config.pi.modelId}, ` +
        `concurrency ${config.concurrency}, validation ${validation}, ${target})`,
    );
  });
}

void start().catch((error: unknown) => {
  console.error(
    '[build-worker] refusing to start:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.info(
      `[build-worker] ${signal} received; finishing in-flight builds`,
    );
    reconciler.stop();
    server.close();
    void queue.drain().then(() => process.exit(0));
  });
}
