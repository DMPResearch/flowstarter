/**
 * Run 9, replayed.
 *
 * Workspace `ba3e9323` on 2026-09-12, as recorded in the showcase notes: the
 * build passed every gate on its second attempt and packaged a correct
 * 6,711,757-byte artifact; the deploy then failed twice for reasons that had
 * nothing to do with the site (a workspace with no host allocated, then a
 * deploy-agent that could not fetch the tarball); the third attempt re-ran the
 * whole generation from scratch and died on `Pi run budget exceeded during
 * "preview_generate": used 1008794 of 1000000 tokens`. The job went terminal
 * with a finished site nobody could ship.
 *
 * The sequence below is that one, with the fix in place. What it asserts is
 * the property the fix exists for: **after the artifact is recorded, no
 * further attempt calls the generator.** The agent is a counter, and it is
 * expected to have run exactly once across all three attempts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FullSiteBuildWorker,
  planBuildResume,
  ProjectState,
  SITE_DEPLOY_FAILED,
  SITE_DEPLOY_NEEDS_OPERATOR,
  type BuiltArtifactRecord,
  type FullSiteBuildJob,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
  type PullRequestPublisher,
  type SafeGitWorktreeManager,
  type SiteValidator,
} from '../src/index';
import { FullSiteBuildFailure } from '../src/flowstarter/workflows';
import { deepTempDir } from './helpers';

const PROJECT_ID = 'ba3e9323-2c74-4166-af29-58ba37f130e5';
const JOB_ID = 'job-run-9';
/** The real artifact from that night, to the byte. */
const ARTIFACT_BYTES = 6_711_757;
const ARTIFACT_SHA = '91a16b62'.padEnd(64, '0');

function job(
  worktreePath: string,
  resume?: FullSiteBuildJob['resume'],
): FullSiteBuildJob {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    kind: 'FULL_SITE_BUILD',
    projectState: ProjectState.DEPOSIT_PAID,
    intake: {
      projectId: PROJECT_ID,
      business: {
        name: 'Dorin Mihai',
        niche: 'Design portfolio',
        location: 'Cluj-Napoca, Romania',
        description: 'A portfolio for a product designer.',
        targetAudience: 'Founders',
        primaryGoal: 'enquiries',
      },
      socialMedia: [],
      locale: 'en-RO',
      submittedAt: '2026-09-12T18:00:00.000Z',
      consent: {
        terms: true,
        privacy: true,
        acceptedAt: '2026-09-12T18:00:00.000Z',
      },
    },
    brandConfig: {
      palette: {
        primary: '#123456',
        secondary: '#654321',
        accent: '#abcdef',
        neutral: '#222222',
        background: '#ffffff',
      },
      typography: { heading: 'Inter', body: 'Inter' },
      voice: 'calm',
    },
    approvedPreviewFiles: [
      {
        path: 'src/content/site.md',
        content: 'Approved preview',
        type: 'file',
      },
    ],
    requiredIntegrations: [],
    ...(resume ? { resume } : {}),
    worktreePath,
  } as unknown as FullSiteBuildJob;
}

function worktreesAt(worktreePath: string): SafeGitWorktreeManager {
  return {
    create: async () => ({
      branch: `client/flowstarter-${PROJECT_ID}`,
      path: worktreePath,
    }),
    commit: async () => 'abc123def456',
  } as unknown as SafeGitWorktreeManager;
}

/**
 * A store with one job's payload in memory, which decides each claim with the
 * *real* rule rather than a scripted answer.
 *
 * That is deliberate: a double that returned `{ resume: 'deploy' }` because
 * the test said so would prove nothing about what the worker will do against
 * the ledger. Here the payload is written by `recordBuiltArtifact` and
 * `markFailed` exactly as the Supabase store writes it, and `planBuildResume`
 * reads it back — so the three attempts below are driven by the same function
 * `claimVerdict` calls in production.
 */
function ledger(worktreePath: string) {
  const payload: Record<string, unknown> = {};
  const failures: Array<{ code: string; phase?: string }> = [];
  const store: FullSiteBuildJobStore = {
    claim: async () =>
      job(worktreePath, planBuildResume({ kind: 'FULL_SITE_BUILD', payload })),
    markAgentWorking: async () => {},
    markRebuildStarted: async () => {},
    markRebuilt: async () => {},
    markHumanQa: async () => {
      payload['buildPhase'] = 'live';
    },
    recordBuiltArtifact: async (_jobId, artifact) => {
      payload['builtArtifact'] = artifact;
      payload['buildPhase'] = 'deploying';
    },
    markFailed: async (_jobId, failure) => {
      failures.push({ code: failure.code, phase: failure.phase });
      if (failure.phase) payload['buildPhase'] = failure.phase;
    },
  };
  return { store, payload, failures };
}

describe('run 9: a gate-passed artifact, and two deploys that failed', () => {
  it('re-deploys the built site instead of generating it again', async () => {
    const worktreePath = await deepTempDir('flowstarter-run9');
    const { store, payload, failures } = ledger(worktreePath);

    let agentPasses = 0;
    const agents = {
      buildFullSite: async (input: { workspaceRoot: string }) => {
        agentPasses += 1;
        await mkdir(join(input.workspaceRoot, 'src/pages'), {
          recursive: true,
        });
        await writeFile(
          join(input.workspaceRoot, 'src/pages/about.astro'),
          '<main>Full site</main>',
          'utf8',
        );
        return { summary: 'built', changedPaths: ['src/pages/about.astro'] };
      },
    } as unknown as PiSdkFlowstarterAgents;
    const validator: SiteValidator = {
      validate: async () => ({ outputDir: null }),
    };

    let packaged = 0;
    let deploys = 0;
    const deployed: BuiltArtifactRecord[] = [];
    // The deploy side, scripted exactly as that night went: 409 workspace
    // unallocated, then a 502 the deploy-agent answered when it could not
    // fetch the tarball, then a deploy that worked.
    const outcomes = [
      () => {
        throw new FullSiteBuildFailure(
          SITE_DEPLOY_NEEDS_OPERATOR,
          'flowstarter-main rejected the deploy with 409 (workspace_unallocated)',
        );
      },
      () => {
        throw new FullSiteBuildFailure(
          SITE_DEPLOY_FAILED,
          'flowstarter-main rejected the deploy with 502 (agent_error): artifact fetch 404',
        );
      },
      () => undefined,
    ];
    const publisher: PullRequestPublisher = {
      create: async (input) => {
        packaged += 1;
        await input.onArtifact?.({
          url: `http://127.0.0.1:8787/artifacts/${PROJECT_ID}-token.tar.gz`,
          path: `/tmp/artifacts/${PROJECT_ID}-token.tar.gz`,
          sha256: ARTIFACT_SHA,
          sizeBytes: ARTIFACT_BYTES,
        });
        deploys += 1;
        outcomes[deploys - 1]?.();
        return { pullRequestUrl: 'artifact', stagingUrl: 'https://site.test' };
      },
      deployArtifact: async ({ artifact }) => {
        deploys += 1;
        deployed.push(artifact);
        outcomes[deploys - 1]?.();
        return {
          pullRequestUrl: artifact.url,
          stagingUrl: 'https://site.test',
        };
      },
    };

    const worker = new FullSiteBuildWorker(
      store,
      worktreesAt(worktreePath),
      agents,
      validator,
      publisher,
    );

    // Attempt 1 — the build that worked, and the 409 that stopped it.
    await expect(worker.run(JOB_ID)).rejects.toThrow(/409/);
    expect(agentPasses).toBe(1);
    expect(packaged).toBe(1);
    // The bytes survived the attempt that produced them. This single line is
    // the whole defect: on 2026-09-12 nothing wrote it, so nothing afterwards
    // could know the site existed.
    expect(payload['builtArtifact']).toMatchObject({
      sha256: ARTIFACT_SHA,
      sizeBytes: ARTIFACT_BYTES,
    });
    expect(payload['buildPhase']).toBe('deploying');

    // Attempt 2 — the deploy-agent's 502. No agent, no packaging: the same
    // artifact goes back to the deploy side.
    await expect(worker.run(JOB_ID)).rejects.toThrow(/502/);
    expect(agentPasses).toBe(1);
    expect(packaged).toBe(1);
    expect(deployed).toHaveLength(1);
    expect(deployed[0]?.sha256).toBe(ARTIFACT_SHA);

    // Attempt 3 — which on the night re-ran the whole generation and burned
    // the token budget. It deploys, and the client gets their site.
    await worker.run(JOB_ID);
    expect(agentPasses).toBe(1);
    expect(packaged).toBe(1);
    expect(deployed).toHaveLength(2);
    expect(payload['buildPhase']).toBe('live');

    // Every failure was recorded on the deploy side, which is what keeps the
    // artifact re-usable and the generation budget untouched.
    expect(failures.map((f) => f.phase)).toEqual(['deploying', 'deploying']);
    expect(failures.map((f) => f.code)).toEqual([
      SITE_DEPLOY_NEEDS_OPERATOR,
      SITE_DEPLOY_FAILED,
    ]);
  });

  it('records the gates the artifact passed, so nothing unvouched is re-deployed', async () => {
    const worktreePath = await deepTempDir('flowstarter-run9-gates');
    const { store, payload } = ledger(worktreePath);
    const agents = {
      buildFullSite: async (input: { workspaceRoot: string }) => {
        await mkdir(join(input.workspaceRoot, 'src/pages'), {
          recursive: true,
        });
        await writeFile(
          join(input.workspaceRoot, 'src/pages/about.astro'),
          '<main>Full site</main>',
          'utf8',
        );
        return { summary: 'built', changedPaths: ['src/pages/about.astro'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    await new FullSiteBuildWorker(
      store,
      worktreesAt(worktreePath),
      agents,
      { validate: async () => ({ outputDir: null }) } as SiteValidator,
      {
        create: async (input) => {
          await input.onArtifact?.({
            url: 'http://127.0.0.1:8787/artifacts/a.tar.gz',
            sha256: ARTIFACT_SHA,
            sizeBytes: ARTIFACT_BYTES,
          });
          return { pullRequestUrl: 'artifact', stagingUrl: 's' };
        },
      } as PullRequestPublisher,
    ).run(JOB_ID);

    const artifact = payload['builtArtifact'] as BuiltArtifactRecord;
    // The named gates this build actually cleared, in the order it ran them.
    // `parseBuiltArtifact` refuses an artifact whose list is empty, so this is
    // what makes "gate-passed" a recorded fact rather than an assumption.
    expect(artifact.gateReport.passed).toContain('build');
    expect(artifact.gateReport.passed).toContain('page-budget');
    expect(artifact.gateReport.passed).toContain('markup-policy');
    expect(artifact.gateReport.passed).toContain('acceptable-use');
    expect(artifact.commitSha).toBe('abc123def456');
  });

  it('builds the site again when a publisher cannot be resumed', async () => {
    // A publisher with no `deployArtifact` — the GitHub one — has no way to
    // ship recorded bytes, so a job carrying an artifact still gets a build.
    // The resume is an optimisation the worker takes only when the publisher
    // can honour it, never an assumption about what a publisher supports.
    const worktreePath = await deepTempDir('flowstarter-run9-nodeploy');
    const { store, payload } = ledger(worktreePath);
    payload['builtArtifact'] = {
      url: 'http://127.0.0.1:8787/artifacts/a.tar.gz',
      sha256: ARTIFACT_SHA,
      sizeBytes: ARTIFACT_BYTES,
      commitSha: 'abc123def456',
      branch: `client/flowstarter-${PROJECT_ID}`,
      gateReport: { passed: ['build'], at: '2026-09-12T20:00:00.000Z' },
      recordedAt: '2026-09-12T20:00:00.000Z',
    } satisfies BuiltArtifactRecord;
    payload['buildPhase'] = 'deploying';

    let agentPasses = 0;
    const agents = {
      buildFullSite: async (input: { workspaceRoot: string }) => {
        agentPasses += 1;
        await mkdir(join(input.workspaceRoot, 'src/pages'), {
          recursive: true,
        });
        await writeFile(
          join(input.workspaceRoot, 'src/pages/about.astro'),
          '<main>Full site</main>',
          'utf8',
        );
        return { summary: 'built', changedPaths: ['src/pages/about.astro'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    await new FullSiteBuildWorker(
      store,
      worktreesAt(worktreePath),
      agents,
      { validate: async () => ({ outputDir: null }) } as SiteValidator,
      {
        create: async () => ({ pullRequestUrl: 'u', stagingUrl: 's' }),
      } as PullRequestPublisher,
    ).run(JOB_ID);

    expect(agentPasses).toBe(1);
  });
});
