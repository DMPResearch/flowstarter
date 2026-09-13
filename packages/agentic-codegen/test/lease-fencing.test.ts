/**
 * The two things a build has to be able to stop for, and the one thing it has
 * to hand on.
 *
 * A lease says somebody is running a job; a fencing token says which run. When
 * a slow worker misses its heartbeats for longer than the TTL, the job is
 * legitimately reclaimed and rebuilt by somebody else — and the slow one keeps
 * going. These prove that the overtaken attempt cannot publish, cannot finish
 * and cannot fail the job that was taken from it, and that it gives up as soon
 * as it is told rather than after it has spent another agent pass.
 *
 * The third describes the handover the containment fix introduced: the
 * validator exports the build output into a directory the worker owns, and the
 * publisher packages that copy rather than re-reading the worktree.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FullSiteBuildWorker,
  LeaseLostError,
  ProjectState,
  type FullSiteBuildJob,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
  type PullRequestPublisher,
  type SafeGitWorktreeManager,
  type SiteValidator,
} from '../src/index';
import { deepTempDir } from './helpers';

const PROJECT_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

function job(worktreePath: string): FullSiteBuildJob {
  return {
    id: 'job-1',
    projectId: PROJECT_ID,
    kind: 'FULL_SITE_BUILD',
    projectState: ProjectState.DEPOSIT_PAID,
    intake: {
      projectId: PROJECT_ID,
      business: {
        name: 'Calm Path Therapy',
        niche: 'Therapy practice',
        location: 'Cluj-Napoca, Romania',
        description: 'Calm, practical therapy for founders and creatives.',
        targetAudience: 'Founders and creative professionals',
        primaryGoal: 'bookings',
      },
      socialMedia: [],
      locale: 'en-RO',
      submittedAt: '2026-08-11T10:00:00.000Z',
      consent: {
        terms: true,
        privacy: true,
        acceptedAt: '2026-08-11T10:00:00.000Z',
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
    worktreePath,
  } as unknown as FullSiteBuildJob;
}

/** A store that answers the claim and records every write it is asked for. */
function storeFor(
  worktreePath: string,
  overrides: Partial<FullSiteBuildJobStore> = {},
): { store: FullSiteBuildJobStore; writes: string[] } {
  const writes: string[] = [];
  const store: FullSiteBuildJobStore = {
    claim: async () => job(worktreePath),
    markAgentWorking: async () => {
      writes.push('agent-working');
    },
    markRebuildStarted: async () => {},
    markRebuilt: async () => {},
    markHumanQa: async () => {
      writes.push('human-qa');
    },
    markFailed: async () => {
      writes.push('failed');
    },
    ...overrides,
  };
  return { store, writes };
}

function agentsThatWrite(): PiSdkFlowstarterAgents {
  return {
    buildFullSite: async (input: { workspaceRoot: string }) => {
      await mkdir(join(input.workspaceRoot, 'src/pages'), { recursive: true });
      await writeFile(
        join(input.workspaceRoot, 'src/pages/about.astro'),
        '<main>Full site</main>',
        'utf8',
      );
      return { summary: 'built', changedPaths: ['src/pages/about.astro'] };
    },
  } as unknown as PiSdkFlowstarterAgents;
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

describe('a build that no longer holds its job', () => {
  it('cannot publish, finish or fail a job another worker has reclaimed', async () => {
    const worktreePath = await deepTempDir('flowstarter-fencing-publish');
    let published = 0;
    const { store, writes } = storeFor(worktreePath, {
      // The authoritative answer, read from the ledger row: this run's token
      // is not the row's any more.
      assertHoldsLease: async () => {
        throw new LeaseLostError('reclaimed by another worker');
      },
      // The real store refuses the same way, which is what the workflow has to
      // survive without replacing the error it is already carrying.
      markFailed: async () => {
        writes.push('failed');
        throw new LeaseLostError('reclaimed by another worker');
      },
    });

    const publisher: PullRequestPublisher = {
      create: async () => {
        published += 1;
        return {
          pullRequestUrl: 'https://example.test/pr/1',
          stagingUrl: 'https://example.test',
        };
      },
    };
    const validator: SiteValidator = {
      validate: async () => ({ outputDir: null }),
    };

    await expect(
      new FullSiteBuildWorker(
        store,
        worktreesAt(worktreePath),
        agentsThatWrite(),
        validator,
        publisher,
      ).run('job-1'),
    ).rejects.toBeInstanceOf(LeaseLostError);

    // It got all the way to the publish — this is the attempt that was
    // overtaken mid-build, not one that failed early — and was refused there.
    expect(writes).toContain('agent-working');
    // Nothing was published, and nothing was written to the ledger that the
    // run which now owns the job would have to argue with.
    expect(published).toBe(0);
    expect(writes).not.toContain('human-qa');
  });

  it('stops at its next phase once the heartbeat says the lease is gone', async () => {
    const worktreePath = await deepTempDir('flowstarter-fencing-cancel');
    let agentPasses = 0;
    const { store } = storeFor(worktreePath);
    const agents = {
      buildFullSite: async () => {
        agentPasses += 1;
        return { summary: 'built', changedPaths: ['src/pages/about.astro'] };
      },
    } as unknown as PiSdkFlowstarterAgents;

    // Already aborted: the host aborts this the moment its heartbeat comes
    // back false, and the build must not spend another pass after that.
    const lost = new AbortController();
    lost.abort();

    await expect(
      new FullSiteBuildWorker(
        store,
        worktreesAt(worktreePath),
        agents,
        { validate: async () => ({ outputDir: null }) } as SiteValidator,
        {
          create: async () => ({ pullRequestUrl: 'u', stagingUrl: 's' }),
        } as PullRequestPublisher,
      ).run('job-1', { signal: lost.signal }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    expect(agentPasses).toBe(0);
  });
});

describe('the build output a publisher is handed', () => {
  it('is the validator export, not the worktree it was built in', async () => {
    const worktreePath = await deepTempDir('flowstarter-export-handover');
    const exported = await deepTempDir('flowstarter-export-copy');
    await writeFile(join(exported, 'index.html'), '<h1>exported</h1>', 'utf8');

    const { store } = storeFor(worktreePath);
    let outputRoot: string | null | undefined = 'unset';
    const publisher: PullRequestPublisher = {
      create: async (input) => {
        outputRoot = input.outputRoot;
        return {
          pullRequestUrl: 'https://example.test/pr/1',
          stagingUrl: 'https://example.test',
        };
      },
    };

    await new FullSiteBuildWorker(
      store,
      worktreesAt(worktreePath),
      agentsThatWrite(),
      { validate: async () => ({ outputDir: exported }) } as SiteValidator,
      publisher,
    ).run('job-1');

    expect(outputRoot).toBe(exported);
  });
});
