/**
 * The worker's half of the deploy-only retry.
 *
 * Three things have to be true for a stuck build to be finishable, and each of
 * them lives in a different file here:
 *
 *  - the publisher has to say what it packaged *before* it tries to deploy it,
 *    and has to be able to deploy those bytes again on their own
 *    (`local-publisher.ts`);
 *  - a deploy refusal has to carry a code that says whether trying again could
 *    ever help (`local-publisher.ts` into `failure-policy.ts`);
 *  - and the claim rule has to charge a redeploy to the deploy budget rather
 *    than to a paying client's generation budget (`leases.ts`).
 *
 * The end-to-end replay of run 9 itself lives with the workflow, in
 * `packages/agentic-codegen/test/deploy-only-retry.test.ts`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SITE_DEPLOY_FAILED,
  SITE_DEPLOY_NEEDS_OPERATOR,
  type BuiltArtifactRecord,
  type PackagedArtifact,
} from '@flowstarter/agentic-codegen';
import { ArtifactStore } from '../src/artifacts';
import { classifyBuildFailure } from '../src/failure-policy';
import { attemptVerdict, claimVerdict, type LeasedJobRow } from '../src/leases';
import { LocalSitePublisher } from '../src/local-publisher';

const PROJECT_ID = 'ba3e9323-2c74-4166-af29-58ba37f130e5';
const SHA = 'a'.repeat(64);

let scratch = '';
let siteRoot = '';
let artifactsRoot = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'fs-deploy-retry-'));
  siteRoot = join(scratch, 'site');
  artifactsRoot = join(scratch, 'artifacts');
  await mkdir(join(siteRoot, 'dist'), { recursive: true });
  await writeFile(join(siteRoot, 'dist/index.html'), '<h1>Dorin</h1>', 'utf8');
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** The named failure a deploy throws: `code` is what the ledger reads. */
interface Err {
  code?: string;
  message?: string;
}

function publisher(opts: {
  calls: Call[];
  respond?: () => Response;
}): LocalSitePublisher {
  return new LocalSitePublisher({
    store: new ArtifactStore({
      root: artifactsRoot,
      baseUrl: 'http://127.0.0.1:8787',
    }),
    flowstarterMainUrl: 'http://127.0.0.1:3005',
    sharedSecret: 's'.repeat(48),
    outputDir: 'dist',
    stagingUrlTemplate: 'http://localhost:8788/{projectId}/',
    fetchImpl: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      opts.calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return (
        opts.respond?.() ??
        Response.json({
          deployment: { deploymentId: 'dep_1', status: 'live' },
          siteUrl: 'http://localhost:8788/dorin/',
        })
      );
    }) as typeof globalThis.fetch,
  });
}

describe('the publisher says what it packaged before it deploys it', () => {
  it('reports the artifact, and reports it before the deploy request goes out', async () => {
    const calls: Call[] = [];
    const seen: Array<{ artifact: PackagedArtifact; callsSoFar: number }> = [];
    const result = await publisher({ calls }).create({
      projectId: PROJECT_ID,
      branch: `client/flowstarter-${PROJECT_ID}`,
      worktreePath: join(scratch, 'worktree'),
      commitSha: 'a'.repeat(40),
      siteRoot,
      onArtifact: async (artifact) => {
        seen.push({ artifact, callsSoFar: calls.length });
      },
    });

    expect(seen).toHaveLength(1);
    // Before, not after. A deploy that fails is exactly the case the record is
    // for, so a record written afterwards would never exist when it is needed.
    expect(seen[0]?.callsSoFar).toBe(0);
    expect(seen[0]?.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]?.artifact.sizeBytes).toBeGreaterThan(0);
    // The same digest the deploy then asks the host to verify.
    expect(calls[0]?.body['artifactSha256']).toBe(seen[0]?.artifact.sha256);
    expect(result.stagingUrl).toBe('http://localhost:8788/dorin/');
  });
});

describe('deploying an artifact that already exists', () => {
  it('sends the recorded bytes and digest, and packages nothing', async () => {
    const calls: Call[] = [];
    const artifact: BuiltArtifactRecord = {
      url: 'http://127.0.0.1:8787/artifacts/job-token.tar.gz',
      sha256: SHA,
      sizeBytes: 6_711_757,
      commitSha: 'abc123',
      branch: `client/flowstarter-${PROJECT_ID}`,
      gateReport: { passed: ['build'], at: '2026-09-12T20:00:00.000Z' },
      recordedAt: '2026-09-12T20:00:00.000Z',
    };

    const result = await publisher({ calls }).deployArtifact({
      projectId: PROJECT_ID,
      artifact,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:3005/api/internal/build/deploy',
    );
    expect(calls[0]?.body).toMatchObject({
      workspaceId: PROJECT_ID,
      artifactUrl: artifact.url,
      artifactSha256: SHA,
      commitSha: 'abc123',
    });
    expect(result.pullRequestUrl).toBe(artifact.url);
    // Nothing was packed: the site root was never read, and no new tarball
    // exists beside the one the original attempt wrote.
    await expect(
      import('node:fs/promises').then((fs) => fs.readdir(artifactsRoot)),
    ).rejects.toThrow();
  });

  it('names a refusal a person has to clear, and one worth trying again', async () => {
    // The two answers from run 9, in the shape the route actually returns
    // them. The classification comes from the structured `code`, never from
    // the status line or the prose.
    const unallocated = await publisher({
      calls: [],
      respond: () =>
        Response.json(
          { error: 'workspace has no server', code: 'workspace_unallocated' },
          { status: 409 },
        ),
    })
      .deployArtifact({
        projectId: PROJECT_ID,
        artifact: {
          url: 'http://127.0.0.1:8787/artifacts/job-token.tar.gz',
          sha256: SHA,
          sizeBytes: 1,
          commitSha: 'abc123',
          branch: 'b',
          gateReport: { passed: ['build'], at: '' },
          recordedAt: '',
        },
      })
      .then(() => ({}) as Err)
      .catch((error: unknown) => error as Err);
    expect(unallocated.code).toBe(SITE_DEPLOY_NEEDS_OPERATOR);
    // Terminal: retrying cannot allocate a host, and the job stops for a
    // person rather than looping every fifteen minutes.
    expect(
      classifyBuildFailure({ error_code: SITE_DEPLOY_NEEDS_OPERATOR }),
    ).toBe('terminal');

    const agentDown = await publisher({
      calls: [],
      respond: () =>
        Response.json(
          { error: 'deploy-agent 502', code: 'agent_error' },
          { status: 502 },
        ),
    })
      .deployArtifact({
        projectId: PROJECT_ID,
        artifact: {
          url: 'http://127.0.0.1:8787/artifacts/job-token.tar.gz',
          sha256: SHA,
          sizeBytes: 1,
          commitSha: 'abc123',
          branch: 'b',
          gateReport: { passed: ['build'], at: '' },
          recordedAt: '',
        },
      })
      .then(() => ({}) as Err)
      .catch((error: unknown) => error as Err);
    expect(agentDown.code).toBe(SITE_DEPLOY_FAILED);
    expect(classifyBuildFailure({ error_code: SITE_DEPLOY_FAILED })).toBe(
      'transient',
    );
  });
});

describe('a redeploy whose transport or answer is unusable', () => {
  const artifact: BuiltArtifactRecord = {
    url: 'http://127.0.0.1:8787/artifacts/job-token.tar.gz',
    sha256: SHA,
    sizeBytes: 1,
    commitSha: 'abc123',
    branch: 'b',
    gateReport: { passed: ['build'], at: '' },
    recordedAt: '',
  };

  it('falls back to the configured staging url when the deploy names none', async () => {
    const result = await publisher({
      calls: [],
      respond: () => Response.json({ deployment: { status: 'live' } }),
    }).deployArtifact({ projectId: PROJECT_ID, artifact });
    expect(result.stagingUrl).toBe(`http://localhost:8788/${PROJECT_ID}/`);
  });

  it('treats an unreachable deploy as worth trying again', async () => {
    // Nothing was decided about the site: the request never arrived. The
    // retryable reading is the only one that cannot strand a paid build.
    const failed = await publisher({
      calls: [],
      respond: () => {
        throw new Error('ECONNREFUSED');
      },
    })
      .deployArtifact({ projectId: PROJECT_ID, artifact })
      .then(() => ({}) as Err)
      .catch((error: unknown) => error as Err);
    expect(failed.code).toBe(SITE_DEPLOY_FAILED);
  });

  it('treats a refusal whose body is not JSON as worth trying again', async () => {
    const failed = await publisher({
      calls: [],
      respond: () =>
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    })
      .deployArtifact({ projectId: PROJECT_ID, artifact })
      .then(() => ({}) as Err)
      .catch((error: unknown) => error as Err);
    expect(failed.code).toBe(SITE_DEPLOY_FAILED);
  });

  it('fails a deploy that finished in any state but live', async () => {
    const failed = await publisher({
      calls: [],
      respond: () =>
        Response.json({
          deployment: { status: 'failed', detail: 'caddy reload refused' },
        }),
    })
      .deployArtifact({ projectId: PROJECT_ID, artifact })
      .then(() => ({}) as Err)
      .catch((error: unknown) => error as Err);
    expect(failed.code).toBe(SITE_DEPLOY_FAILED);
    expect(failed.message).toContain('caddy reload refused');
  });
});

describe('which budget a retry spends', () => {
  const NOW = Date.parse('2026-09-12T22:00:00.000Z');
  const RULES = {
    now: NOW,
    maxAttempts: 3,
    maxDeployAttempts: 5,
    leaseTtlMs: 120_000,
  };
  const artifact: BuiltArtifactRecord = {
    url: 'http://127.0.0.1:8787/artifacts/job-token.tar.gz',
    sha256: SHA,
    sizeBytes: 6_711_757,
    commitSha: 'abc123',
    branch: 'b',
    gateReport: { passed: ['build'], at: '2026-09-12T20:00:00.000Z' },
    recordedAt: '2026-09-12T20:00:00.000Z',
  };

  function row(payload: unknown, attempts = 3): LeasedJobRow {
    return {
      id: 'f2a1c9d0-0000-4000-8000-000000000001',
      kind: 'FULL_SITE_BUILD',
      status: 'failed',
      error_code: SITE_DEPLOY_FAILED,
      attempt_count: attempts,
      payload,
    };
  }

  it('takes a job whose generation budget is spent but whose site is built', () => {
    // This is the run-9 row exactly: three attempts on the clock, terminal by
    // the old rule, and a correct artifact sitting on disk. The claim rule now
    // measures it against the deploy budget instead, and plans a deploy.
    const verdict = claimVerdict(
      row({ builtArtifact: artifact, buildPhase: 'deploying' }),
      RULES,
    );
    expect(verdict).toEqual({
      claimable: true,
      recovered: false,
      plan: { resume: 'deploy', artifact },
    });
  });

  it('still stops a job that has nothing built and no attempts left', () => {
    expect(claimVerdict(row({}), RULES)).toEqual({
      claimable: false,
      reason: 'attempts-exhausted',
    });
  });

  it('stops once the deploy budget itself is spent', () => {
    // Its own refusal, and its own name. A site that cannot be deployed five
    // times running is not waiting on a retry.
    const spent = row({
      builtArtifact: artifact,
      buildPhase: 'deploying',
      attempts: { generation: 2, deploy: 5 },
    });
    expect(claimVerdict(spent, RULES)).toEqual({
      claimable: false,
      reason: 'deploy-attempts-exhausted',
    });
    // And an operator's grant re-opens it, without resetting the history.
    const granted = row({
      builtArtifact: artifact,
      buildPhase: 'deploying',
      attempts: { generation: 2, deploy: 5, deployMax: 6 },
    });
    expect(attemptVerdict(granted, RULES)).toEqual({
      plan: { resume: 'deploy', artifact },
    });
  });

  it('measures a generation retry against the generation budget alone', () => {
    // Four deploy failures do not bring a build one step closer to being out
    // of generation attempts, which is the whole point of counting them apart.
    const mixed = row({ attempts: { generation: 1, deploy: 4 } }, 5);
    expect(attemptVerdict(mixed, RULES)).toEqual({
      plan: { resume: 'generation', reason: 'no-artifact' },
    });
  });
});
