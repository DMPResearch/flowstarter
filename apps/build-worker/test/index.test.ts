/**
 * Boots the actual worker entry point (`src/index.ts`) end to end over its
 * real HTTP surface, on an ephemeral loopback port -- never 3000 or 3005,
 * which other checkouts' dev servers may be sitting on.
 *
 * `index.ts` has no exports; everything happens as a side effect of import.
 * That means every scenario below imports a fresh copy of the module (after
 * `vi.resetModules()`) with a fresh `process.env` and fresh mocks, and reads
 * the listening `http.Server` back out through a `node:http` spy rather than
 * through any export.
 *
 * Nothing here may reach the network, Supabase, git or Pi: `@supabase/supabase-js`,
 * the Pi/git-worktree/full-site-worker pieces of `@flowstarter/agentic-codegen`,
 * and `./local-repo`'s git bootstrap are all mocked. The only real I/O is
 * loopback HTTP against the server this test just started, and filesystem
 * reads/writes under a per-test tmp directory for the local artifact route.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { connect, createServer as createProbeServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `config.ts` requires a port in [1, 65535] -- it will not accept the literal
 * `0` that normally means "OS, pick one" -- so a free high port is reserved
 * here instead, well clear of 3000 and 3005 which another checkout's dev
 * server may be using.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbeServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const ensureLocalSitesRepositoryMock = vi.hoisted(() =>
  vi.fn(async () => ({ created: false })),
);
const workerRunMock = vi.hoisted(() =>
  vi.fn(
    async (_jobId: string) =>
      new Promise<void>((resolve) => setTimeout(resolve, 20)),
  ),
);
const capturedServers = vi.hoisted(() => [] as Server[]);

vi.mock('../src/local-repo', () => ({
  ensureLocalSitesRepository: ensureLocalSitesRepositoryMock,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));

interface FakeJobLogWriter {
  write: (line: unknown) => void;
  flush: () => Promise<void>;
}

interface JobLogHooks {
  onJobLog?: (jobId: string, log: FakeJobLogWriter) => void;
}

vi.mock('@flowstarter/agentic-codegen', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@flowstarter/agentic-codegen')>();
  return {
    ...actual,
    // The pipeline this worker drives -- Pi session, git worktree, the
    // full-site orchestration itself -- is exactly what "never reach git or
    // Pi in a unit test" rules out. FullSiteBuildWorker.run() is replaced
    // with a short no-op so the queue has something safe to await.
    //
    // These are constructed with `new` in src/index.ts, so the mock
    // implementation has to itself be constructable -- an arrow function
    // cannot be, so a plain `function` is used instead. The mock still
    // invokes the `onJobLog` hook src/index.ts wires up (real
    // FullSiteBuildWorker calls it once a job is claimed), so that glue
    // arrow function is genuinely exercised rather than merely defined.
    FullSiteBuildWorker: vi.fn(function FullSiteBuildWorkerMock(
      this: { run: (jobId: string) => Promise<void> },
      ..._ctorArgs: unknown[]
    ) {
      const hooks = _ctorArgs[5] as JobLogHooks | undefined;
      this.run = async (jobId: string) => {
        hooks?.onJobLog?.(jobId, {
          write: () => {},
          flush: async () => {},
        });
        await workerRunMock(jobId);
      };
    }),
    PiSdkFlowstarterAgents: vi.fn(function PiSdkFlowstarterAgentsMock() {}),
    SafeGitWorktreeManager: vi.fn(function SafeGitWorktreeManagerMock() {}),
  };
});

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (
      ...args: Parameters<typeof actual.createServer>
    ): ReturnType<typeof actual.createServer> => {
      const server = (actual.createServer as (...a: unknown[]) => Server)(
        ...args,
      );
      capturedServers.push(server);
      return server;
    },
  };
});

// Every `boot()` imports a fresh src/index.ts, which registers its own
// SIGTERM/SIGINT handlers on the shared `process` object and never removes
// them (real process lifetime, not a per-test one) -- expected here, not a
// leak in the code under test.
process.setMaxListeners(50);

const SECRET = 's'.repeat(48);
const JOB_ID = '4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11';

/** Every env key `config.ts` reads, so a previous test's value never leaks. */
const CONFIG_ENV_KEYS = [
  'FLOWSTARTER_BUILD_WORKER_SECRET',
  'FLOWSTARTER_BUILD_MODE',
  'FLOWSTARTER_BUILD_WORKER_PORT',
  'FLOWSTARTER_BUILD_WORKER_HOST',
  'FLOWSTARTER_BUILD_STUB_AGENT',
  'FLOWSTARTER_BUILD_SKIP_VALIDATION',
  'FLOWSTARTER_ENV',
  'PI_API_KEY',
  'OPENROUTER_API_KEY',
  'PI_THINKING_LEVEL',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_TIMEOUT_MS',
  'FLOWSTARTER_REPOSITORY_ROOT',
  'FLOWSTARTER_WORKTREES_ROOT',
  'FLOWSTARTER_STAGING_URL_TEMPLATE',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FLOWSTARTER_SITES_BASE_REF',
  'FLOWSTARTER_SITES_REMOTE',
  'GITHUB_API_BASE_URL',
  'FLOWSTARTER_SITES_REPO',
  'FLOWSTARTER_SITES_GITHUB_TOKEN',
  'FLOWSTARTER_BUILD_ARTIFACTS_ROOT',
  'FLOWSTARTER_BUILD_ARTIFACT_BASE_URL',
  'FLOWSTARTER_MAIN_URL',
  'FLOWSTARTER_BUILD_OUTPUT_DIR',
  'FLOWSTARTER_BUILD_VALIDATE_COMMANDS',
  'FLOWSTARTER_BUILD_VALIDATE_ISOLATION',
  'FLOWSTARTER_BUILD_VALIDATE_DOCKER_BIN',
  'FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE',
  'FLOWSTARTER_BUILD_VALIDATE_DOCKER_NETWORK',
  'FLOWSTARTER_BUILD_VALIDATE_DOCKER_MEMORY',
  'FLOWSTARTER_BUILD_VALIDATE_DOCKER_TMPFS_SIZE',
  'FLOWSTARTER_BUILD_VALIDATE_DOCKER_PIDS_LIMIT',
  'FLOWSTARTER_BUILD_VALIDATE_PNPM_VERSION',
  'FLOWSTARTER_BUILD_TIMEOUT_MS',
  'FLOWSTARTER_BUILD_MAX_ATTEMPTS',
  'FLOWSTARTER_BUILD_CONCURRENCY',
  'FLOWSTARTER_BUILD_QUEUE_LIMIT',
] as const;

function resetConfigEnv(): void {
  for (const key of CONFIG_ENV_KEYS) delete process.env[key];
}

interface Booted {
  baseUrl: string;
  server: Server;
}

/** Imports a fresh `src/index.ts` and waits for it to start listening. */
async function boot(envOverrides: Record<string, string>): Promise<Booted> {
  vi.resetModules();
  capturedServers.length = 0;
  resetConfigEnv();
  Object.assign(process.env, envOverrides);

  await import('../src/index');

  const server = capturedServers.at(-1);
  if (!server) throw new Error('src/index.ts did not create an http.Server');
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

async function waitForQueueDrained(baseUrl: string): Promise<void> {
  await vi.waitFor(async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { active: number; waiting: number };
    expect(body.active).toBe(0);
    expect(body.waiting).toBe(0);
  });
}

describe('build worker entry point (src/index.ts)', () => {
  let repositoryRoot: string;
  let worktreesRoot: string;
  let artifactsRoot: string;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    repositoryRoot = await mkdtemp(join(tmpdir(), 'flowstarter-index-repo-'));
    worktreesRoot = await mkdtemp(
      join(tmpdir(), 'flowstarter-index-worktrees-'),
    );
    artifactsRoot = await mkdtemp(
      join(tmpdir(), 'flowstarter-index-artifacts-'),
    );
    ensureLocalSitesRepositoryMock.mockClear();
    ensureLocalSitesRepositoryMock.mockResolvedValue({ created: false });
    workerRunMock.mockClear();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    await Promise.all(
      [repositoryRoot, worktreesRoot, artifactsRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  async function localEnv(
    overrides: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    return {
      FLOWSTARTER_BUILD_WORKER_SECRET: SECRET,
      FLOWSTARTER_BUILD_MODE: 'local',
      FLOWSTARTER_BUILD_STUB_AGENT: 'true',
      FLOWSTARTER_BUILD_WORKER_PORT: String(await freePort()),
      FLOWSTARTER_BUILD_WORKER_HOST: '127.0.0.1',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
      FLOWSTARTER_REPOSITORY_ROOT: repositoryRoot,
      FLOWSTARTER_WORKTREES_ROOT: worktreesRoot,
      FLOWSTARTER_BUILD_ARTIFACTS_ROOT: artifactsRoot,
      FLOWSTARTER_MAIN_URL: 'http://127.0.0.1:1',
      ...overrides,
    };
  }

  describe('local mode', () => {
    it('boots, initialises the local sites repository, and serves /health with no auth', async () => {
      ensureLocalSitesRepositoryMock.mockResolvedValueOnce({ created: true });
      const { baseUrl, server } = await boot(await localEnv());
      try {
        expect(ensureLocalSitesRepositoryMock).toHaveBeenCalledWith(
          repositoryRoot,
          'main',
        );
        // created:true takes the branch that logs the initialisation line.
        expect(consoleInfoSpy).toHaveBeenCalledWith(
          expect.stringContaining('initialised a local sites repository'),
        );

        const res = await fetch(`${baseUrl}/health`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json();
        expect(body).toMatchObject({ ok: true, active: 0, waiting: 0 });
      } finally {
        server.close();
      }
    }, 30_000); // and comes back in well under a second. // a cold cache. Every later `boot()` reuses the transformed modules // instrumentation, which is far slower than the default 10s budget on // the full agentic-codegen module graph under v8 coverage // The first dynamic import of src/index.ts in the whole suite pulls in

    it('rejects a dispatch with no bearer token', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const res = await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          body: JSON.stringify({ jobId: JOB_ID }),
        });
        expect(res.status).toBe(401);
      } finally {
        server.close();
      }
    });

    it('rejects a dispatch with the wrong bearer token', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const res = await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          headers: { authorization: `Bearer ${'x'.repeat(48)}` },
          body: JSON.stringify({ jobId: JOB_ID }),
        });
        expect(res.status).toBe(401);
      } finally {
        server.close();
      }
    });

    it('rejects a malformed JSON body from an otherwise authorized caller', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const res = await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: '{not json',
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'body must be JSON' });
      } finally {
        server.close();
      }
    });

    it('rejects a request body over the size cap before it is ever parsed', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const res = await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: 'x'.repeat(70_000),
        });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({
          error: 'request body is too large',
        });
      } finally {
        server.close();
      }
    });

    it('returns 404 for an unknown route once authorized', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const res = await fetch(`${baseUrl}/not-a-route`, {
          headers: { authorization: `Bearer ${SECRET}` },
        });
        expect(res.status).toBe(404);
      } finally {
        server.close();
      }
    });

    it('accepts a valid dispatch, runs it on the queue, and collapses a concurrent redelivery into a duplicate', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const post = () =>
          fetch(`${baseUrl}/jobs/full-site`, {
            method: 'POST',
            headers: { authorization: `Bearer ${SECRET}` },
            body: JSON.stringify({ jobId: JOB_ID }),
          });

        const [first, second] = await Promise.all([post(), post()]);
        const [firstBody, secondBody] = await Promise.all([
          first.json(),
          second.json(),
        ]);

        expect([first.status, second.status]).toEqual([202, 202]);
        // Exactly one of the two dispatches is the redelivery; both are
        // accepted, but only one is marked duplicate.
        const duplicates = [firstBody, secondBody].filter(
          (b) => (b as { duplicate?: boolean }).duplicate,
        );
        expect(duplicates).toHaveLength(1);

        await waitForQueueDrained(baseUrl);
        expect(workerRunMock).toHaveBeenCalledWith(JOB_ID);
        expect(workerRunMock).toHaveBeenCalledTimes(1);
      } finally {
        server.close();
      }
    });

    it('logs a failed job without crashing the queue, for both an Error and a non-Error rejection', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const jobA = '11111111-1111-4111-8111-111111111111';
        const jobB = '22222222-2222-4222-8222-222222222222';
        workerRunMock.mockRejectedValueOnce(new Error('boom'));

        await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ jobId: jobA }),
        });
        await waitForQueueDrained(baseUrl);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          `[build-worker] job ${jobA} failed:`,
          'boom',
        );

        // A rejection that is not an Error instance must not crash the
        // process either -- the operator log falls back to the raw value.
        workerRunMock.mockRejectedValueOnce('plain-failure');
        await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ jobId: jobB }),
        });
        await waitForQueueDrained(baseUrl);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          `[build-worker] job ${jobB} failed:`,
          'plain-failure',
        );
      } finally {
        server.close();
      }
    });

    it('refuses a jobId that is not a canonical UUID', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const res = await fetch(`${baseUrl}/jobs/full-site`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ jobId: 'not-a-uuid' }),
        });
        expect(res.status).toBe(400);
      } finally {
        server.close();
      }
    });

    it('serves a stored artifact over the unauthenticated local artifact route', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const token = `${JOB_ID.toLowerCase()}-${'a'.repeat(32)}`;
        const bytes = Buffer.from('fake tarball bytes');
        await writeFile(join(artifactsRoot, `${token}.tar.gz`), bytes);

        const res = await fetch(`${baseUrl}/artifacts/${token}.tar.gz`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/gzip');
        expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
      } finally {
        server.close();
      }
    });

    it('returns 404 for an artifact token that was never stored', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const token = `${JOB_ID.toLowerCase()}-${'b'.repeat(32)}`;
        const res = await fetch(`${baseUrl}/artifacts/${token}.tar.gz`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not found' });
      } finally {
        server.close();
      }
    });

    it('falls through to the ordinary authorized routing for a non-GET request that looks like an artifact path', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const token = `${JOB_ID.toLowerCase()}-${'c'.repeat(32)}`;
        // POST, not GET: the artifact branch requires both a matching token
        // and GET, so this must fall through to ordinary auth handling
        // (unauthorized here) rather than serving or 404-ing a file.
        const res = await fetch(`${baseUrl}/artifacts/${token}.tar.gz`, {
          method: 'POST',
        });
        expect(res.status).toBe(401);
      } finally {
        server.close();
      }
    });

    it('closes the server and exits once a SIGTERM finishes draining the queue', async () => {
      const { server } = await boot(await localEnv());
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);
      const closeSpy = vi.spyOn(server, 'close');
      try {
        // Only this boot's own listener, not any earlier test's -- signal
        // listeners accumulate on the shared `process` object across boots,
        // so the freshly registered one is invoked directly rather than via
        // `process.emit`, which would also refire every earlier listener.
        const listeners = process.listeners('SIGTERM');
        const latest = listeners.at(-1) as (() => void) | undefined;
        expect(latest).toBeTypeOf('function');
        latest?.();

        expect(closeSpy).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(processExitSpy).toHaveBeenCalledWith(0);
        });
      } finally {
        processExitSpy.mockRestore();
      }
    });

    it('logs the real-agent target, with no ", stub agent" suffix, when local mode runs the real validator', async () => {
      const { baseUrl, server } = await boot(
        await localEnv({
          FLOWSTARTER_BUILD_STUB_AGENT: 'false',
          PI_API_KEY: 'test-pi-key',
        }),
      );
      try {
        const listeningLine = consoleInfoSpy.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .find((line: string) => line.includes('listening on'));
        expect(listeningLine).toContain('local deploy via');
        expect(listeningLine).not.toContain('stub agent');

        const res = await fetch(`${baseUrl}/health`);
        expect(res.status).toBe(200);
      } finally {
        server.close();
      }
    });

    it('wires the real validator to Docker isolation when the host asks for it', async () => {
      const { baseUrl, server } = await boot(
        await localEnv({
          FLOWSTARTER_BUILD_STUB_AGENT: 'false',
          PI_API_KEY: 'test-pi-key',
          FLOWSTARTER_BUILD_VALIDATE_ISOLATION: 'docker',
          FLOWSTARTER_BUILD_VALIDATE_DOCKER_IMAGE: 'node:22-alpine',
        }),
      );
      try {
        const listeningLine = consoleInfoSpy.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .find((line: string) => line.includes('listening on'));
        // Which isolation a host is running is the first thing to check when a
        // build behaves differently on one machine, so it is in the boot line.
        expect(listeningLine).toContain('validation docker node:22-alpine');

        const res = await fetch(`${baseUrl}/health`);
        expect(res.status).toBe(200);
      } finally {
        server.close();
      }
    });

    it('defaults to native validation, naming it in the boot line', async () => {
      const { server } = await boot(
        await localEnv({
          FLOWSTARTER_BUILD_STUB_AGENT: 'false',
          PI_API_KEY: 'test-pi-key',
        }),
      );
      try {
        const listeningLine = consoleInfoSpy.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .find((line: string) => line.includes('listening on'));
        expect(listeningLine).toContain('validation native');
      } finally {
        server.close();
      }
    });

    it("still runs the real, native validator with the stub agent selected -- dev:local's own shape", async () => {
      // `localEnv()` defaults to `FLOWSTARTER_BUILD_STUB_AGENT: 'true'`, the
      // same combination `dev:local` boots with. The stub agent replaces
      // only the Pi coding session; it must never also swap the validator
      // for the noop one -- that coupling is exactly what let a SITE_REBUILD
      // package an unbuilt Astro source tree and 404 at the deploy-agent.
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const listeningLine = consoleInfoSpy.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .find((line: string) => line.includes('listening on'));
        expect(listeningLine).toContain('stub agent');
        expect(listeningLine).toContain('validation native');
        expect(listeningLine).not.toContain('noop');

        const res = await fetch(`${baseUrl}/health`);
        expect(res.status).toBe(200);
      } finally {
        server.close();
      }
    });

    it('names the noop validator in the boot line only when FLOWSTARTER_BUILD_SKIP_VALIDATION is set', async () => {
      const { server } = await boot(
        await localEnv({ FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true' }),
      );
      try {
        const listeningLine = consoleInfoSpy.mock.calls
          .map((call: unknown[]) => String(call[0]))
          .find((line: string) => line.includes('listening on'));
        expect(listeningLine).toContain(
          'validation noop (FLOWSTARTER_BUILD_SKIP_VALIDATION)',
        );
      } finally {
        server.close();
      }
    });

    it('logs and exits when the local sites bootstrap fails before the server ever listens', async () => {
      vi.resetModules();
      capturedServers.length = 0;
      resetConfigEnv();
      Object.assign(process.env, await localEnv());
      ensureLocalSitesRepositoryMock.mockRejectedValueOnce(
        new Error('git init failed'),
      );
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      try {
        await import('../src/index');
        await vi.waitFor(() => {
          expect(processExitSpy).toHaveBeenCalledWith(1);
        });
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[build-worker] refusing to start:',
          'git init failed',
        );
        // The bootstrap failed before `server.listen()` was ever reached.
        expect(capturedServers.at(-1)?.listening).toBeFalsy();
      } finally {
        processExitSpy.mockRestore();
        capturedServers.at(-1)?.close();
      }
    });

    it('returns 500 and logs when the request stream errors before it can be read', async () => {
      const { baseUrl, server } = await boot(await localEnv());
      try {
        const port = Number(new URL(baseUrl).port);
        await new Promise<void>((resolve) => {
          const socket = connect(port, '127.0.0.1', () => {
            socket.write(
              'POST /jobs/full-site HTTP/1.1\r\n' +
                'Host: 127.0.0.1\r\n' +
                `Authorization: Bearer ${SECRET}\r\n` +
                'Content-Type: application/json\r\n' +
                'Content-Length: 1000\r\n' +
                '\r\n' +
                '{"jobId":"partial',
            );
          });
          // A client that vanishes mid-body must not crash the process --
          // readBody()'s `for await` has to observe the failure rather than
          // hang forever waiting for bytes that are never coming.
          socket.once('connect', () => {
            setTimeout(() => socket.destroy(), 75);
          });
          socket.once('error', () => resolve());
          socket.once('close', () => resolve());
        });

        await vi.waitFor(() => {
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            '[build-worker] request failed:',
            expect.anything(),
          );
        });
      } finally {
        server.close();
      }
    });
  });

  describe('github mode', () => {
    it('wires up the GitHub publish path and still serves /health', async () => {
      const { baseUrl, server } = await boot({
        FLOWSTARTER_BUILD_WORKER_SECRET: SECRET,
        FLOWSTARTER_BUILD_MODE: 'github',
        FLOWSTARTER_BUILD_WORKER_PORT: String(await freePort()),
        FLOWSTARTER_BUILD_WORKER_HOST: '127.0.0.1',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
        PI_API_KEY: 'test-pi-key',
        FLOWSTARTER_REPOSITORY_ROOT: repositoryRoot,
        FLOWSTARTER_WORKTREES_ROOT: worktreesRoot,
        FLOWSTARTER_SITES_REPO: 'acme/sites',
        FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp_test_token',
      });
      try {
        // github mode never initialises a local sites repository.
        expect(ensureLocalSitesRepositoryMock).not.toHaveBeenCalled();

        const res = await fetch(`${baseUrl}/health`);
        expect(res.status).toBe(200);

        // No local artifact route exists outside local mode: `artifacts` is
        // null, so the path falls straight through to ordinary routing,
        // which demands auth before it even considers the path unknown.
        const artifactRes = await fetch(`${baseUrl}/artifacts/anything.tar.gz`);
        expect(artifactRes.status).toBe(401);
      } finally {
        server.close();
      }
    });
  });

  describe('configuration failure', () => {
    it('logs and exits without starting a server when required config is missing', async () => {
      vi.resetModules();
      capturedServers.length = 0;
      resetConfigEnv();
      // FLOWSTARTER_BUILD_WORKER_SECRET intentionally left unset.
      Object.assign(process.env, {
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
      });
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => {
          throw new Error('process.exit(1) called');
        });

      try {
        await expect(import('../src/index')).rejects.toThrow(
          'process.exit(1) called',
        );
        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('refusing to start'),
        );
        expect(capturedServers).toHaveLength(0);
      } finally {
        processExitSpy.mockRestore();
      }
    });

    it('refuses to boot with FLOWSTARTER_BUILD_SKIP_VALIDATION set on a staging host', async () => {
      vi.resetModules();
      capturedServers.length = 0;
      resetConfigEnv();
      Object.assign(process.env, {
        FLOWSTARTER_BUILD_WORKER_SECRET: SECRET,
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
        PI_API_KEY: 'test-pi-key',
        FLOWSTARTER_REPOSITORY_ROOT: '/srv/flowstarter/sites',
        FLOWSTARTER_WORKTREES_ROOT: '/srv/flowstarter/worktrees',
        FLOWSTARTER_SITES_REPO: 'flowstarter/sites',
        FLOWSTARTER_SITES_GITHUB_TOKEN: 'ghp_token',
        FLOWSTARTER_BUILD_SKIP_VALIDATION: 'true',
        FLOWSTARTER_ENV: 'staging',
      });
      const processExitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => {
          throw new Error('process.exit(1) called');
        });

      try {
        await expect(import('../src/index')).rejects.toThrow(
          'process.exit(1) called',
        );
        expect(processExitSpy).toHaveBeenCalledWith(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('FLOWSTARTER_BUILD_SKIP_VALIDATION'),
        );
        expect(capturedServers).toHaveLength(0);
      } finally {
        processExitSpy.mockRestore();
      }
    });
  });
});
