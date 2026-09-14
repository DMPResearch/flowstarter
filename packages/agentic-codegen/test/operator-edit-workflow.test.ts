/**
 * The OPERATOR_EDIT_BUILD leg of the worker.
 *
 * Three claims, and they are the whole design:
 *
 *   1. It refuses to publish over a site that does not exist, and refuses a
 *      job that cannot name its session, before it touches a worktree.
 *   2. It runs every output gate and **no agent pass**. The operator already
 *      did the work, interactively; an unattended repair pass over a feature
 *      they deliberately built is how intent gets quietly undone.
 *   3. A gate that refuses stops the job before anything is committed, saved
 *      or published, and the client's site is left exactly as it was.
 *
 * The intake and brand config are cast stubs on purpose: this leg reads
 * neither. Everything it does read -- the session's own files, the booking
 * link, the capture endpoint -- is passed explicitly below.
 */
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { deepTempDir } from './helpers';
import {
  FullSiteBuildWorker,
  ProjectState,
  type ContentPolicyScanner,
  type BrandConfig,
  type BusinessIntakePayload,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
  type PullRequestPublisher,
  type SafeGitWorktreeManager,
  type SiteValidator,
} from '../src/index';

const PROJECT_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const SESSION_ID = 'bb0ce0b6-2f22-4c2c-9a5a-1111aaaa2222';

const intake = { projectId: PROJECT_ID } as unknown as BusinessIntakePayload;
const brandConfig = {} as unknown as BrandConfig;

const temporaryDirectories: string[] = [];
afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

function operatorIntent(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    operatorId: 'user_operator',
    baseVersion: 4,
    commitSha: 'abc1234def',
    note: 'added the pricing page they asked for on the call',
    ...overrides,
  };
}

/** The bits of the store surface every case needs, with the rest stubbed. */
function stubStore(calls: string[]): FullSiteBuildJobStore {
  return {
    claim: async () => null,
    markAgentWorking: async () => {
      calls.push('store:agents-working');
    },
    markHumanQa: async () => {
      calls.push('store:human-qa');
    },
    markRebuildStarted: async () => undefined,
    markRebuilt: async () => undefined,
    markFailed: async (_jobId, error) => {
      calls.push(`store:failed:${error.code}`);
    },
  };
}

describe('OPERATOR_EDIT_BUILD preconditions', () => {
  it('refuses to publish over a site that does not exist yet', async () => {
    const calls: string[] = [];
    const store: FullSiteBuildJobStore = {
      ...stubStore(calls),
      claim: async (jobId) => ({
        id: jobId,
        projectId: PROJECT_ID,
        kind: 'OPERATOR_EDIT_BUILD',
        projectState: ProjectState.DEPOSIT_PAID,
        intake,
        brandConfig,
        approvedPreviewFiles: [],
        requiredIntegrations: [],
        operatorEdit: operatorIntent(),
      }),
    };
    const worktrees = {
      create: async () => {
        calls.push('worktree:created');
        throw new Error('must not run');
      },
    } as unknown as SafeGitWorktreeManager;

    await new FullSiteBuildWorker(
      store,
      worktrees,
      {} as PiSdkFlowstarterAgents,
      {} as SiteValidator,
      {} as PullRequestPublisher,
    ).run('job-op-state');

    expect(calls).toEqual(['store:failed:OPERATOR_EDIT_INVALID_STATE']);
  });

  it('refuses a job that names no session rather than publishing what it finds', async () => {
    const calls: string[] = [];
    const store: FullSiteBuildJobStore = {
      ...stubStore(calls),
      claim: async (jobId) => ({
        id: jobId,
        projectId: PROJECT_ID,
        kind: 'OPERATOR_EDIT_BUILD',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake,
        brandConfig,
        approvedPreviewFiles: [],
        requiredIntegrations: [],
        operatorEdit: null,
      }),
    };
    const worktrees = {
      create: async () => {
        calls.push('worktree:created');
        throw new Error('must not run');
      },
    } as unknown as SafeGitWorktreeManager;

    await new FullSiteBuildWorker(
      store,
      worktrees,
      {} as PiSdkFlowstarterAgents,
      {} as SiteValidator,
      {} as PullRequestPublisher,
    ).run('job-op-empty');

    expect(calls).toEqual(['store:failed:OPERATOR_EDIT_MANIFEST_MISSING']);
  });
});

describe('OPERATOR_EDIT_BUILD, end to end', () => {
  it('runs every gate, no agent pass, then commits, saves and publishes', async () => {
    const calls: string[] = [];
    const events: Array<{ kind: string; body: string }> = [];
    const worktreeRoot = await deepTempDir('flowstarter-operator-edit');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      ...stubStore(calls),
      claim: async (jobId) => ({
        id: jobId,
        projectId: PROJECT_ID,
        kind: 'OPERATOR_EDIT_BUILD',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake,
        brandConfig,
        // The operator's own worktree, handed over by the job store off the
        // session row -- never the client's live files.
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content:
              'Calm Path Therapy, and now a pricing page the client asked for.',
            type: 'file',
          },
          {
            path: 'src/pages/pricing.astro',
            content: '<h1>Pricing</h1>',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
        operatorEdit: operatorIntent(),
      }),
      markOperatorEditStarted: async (_jobId, worktree) => {
        calls.push('store:operator-started');
        expect(worktree.path).toBe(worktreeRoot);
      },
      saveOperatorEditVersion: async (_jobId, input) => {
        calls.push('store:version-saved');
        expect(input.sessionId).toBe(SESSION_ID);
        // The page the operator added survives into the saved manifest. This
        // is the point of the whole path, and the thing the change-request
        // leg's page budget would rightly have refused.
        expect(
          input.files.some((file) => file.path === 'src/pages/pricing.astro'),
        ).toBe(true);
        return { version: 5 };
      },
      markOperatorEditBuilt: async (_jobId, result) => {
        calls.push('store:operator-shipped');
        expect(result.sessionId).toBe(SESSION_ID);
        expect(result.version).toBe(5);
        expect(result.commitSha).toBe('0pe4a70');
      },
      appendEvent: async (_jobId, event) => {
        events.push({ kind: event.kind, body: event.body });
      },
    };

    const worktrees = {
      discard: async () => {
        calls.push('worktree:discard');
      },
      create: async () => {
        calls.push('worktree:create');
        return {
          branch: `client/flowstarter-${PROJECT_ID}`,
          path: worktreeRoot,
        };
      },
      commit: async (_worktree: unknown, message: string) => {
        calls.push('worktree:commit');
        // Through the same policy table every other kind writes, so a ship
        // cannot die at the last step the way #146's change build did.
        expect(message).toBe(
          `build: ship operator editor session to site ${PROJECT_ID}`,
        );
        return '0pe4a70';
      },
    } as unknown as SafeGitWorktreeManager;

    const agents = {
      buildFullSite: async () => {
        calls.push('agent:pass');
        throw new Error('no agent may run on the operator path');
      },
    } as unknown as PiSdkFlowstarterAgents;

    const validator: SiteValidator = {
      validate: async (_root, phase) => {
        calls.push(`validator:${phase}`);
      },
    };

    const pullRequests: PullRequestPublisher = {
      create: async (input) => {
        calls.push('publisher:deploy');
        expect(input.siteVersion).toBe(5);
        return {
          pullRequestUrl: 'https://example.test/deploy/44',
          stagingUrl: 'https://calm-path.flowstarter.net',
        };
      },
    };

    await new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
    ).run('job-op-ok');

    expect(calls).toEqual([
      'worktree:discard',
      'worktree:create',
      'store:operator-started',
      'validator:full',
      // Commit before save, the order #146 paid for: the commit is a local
      // worktree nobody has seen, the version is the row a client is told
      // about, so the version is taken last.
      'worktree:commit',
      'store:version-saved',
      'publisher:deploy',
      'store:operator-shipped',
    ]);
    expect(calls).not.toContain('agent:pass');
    // The engagement does not move: a live client whose site one of us
    // improved has not gone back into the build pipeline.
    expect(calls).not.toContain('store:agents-working');
    expect(calls).not.toContain('store:human-qa');

    const phases = events
      .filter((event) => event.kind === 'phase')
      .map((event) => event.body);
    expect(phases).toEqual([
      'Preparing a clean worktree',
      'Materializing the operator session',
      'Checking the build',
      'Checking for placeholder copy',
      'Checking for placeholder images',
      'Checking what the site asks the browser to do',
      'Checking for empty image elements',
      'Checking the site against the acceptable-use policy',
      'Committing the site',
      'Saving the new version of the site',
      'Publishing',
      'Live, in version 5',
    ]);

    const logs = events
      .filter((event) => event.kind === 'log')
      .map((event) => event.body);
    // The operator's note is on the record, on a line of its own, never
    // folded into a sentence the product speaks in its own voice.
    expect(
      logs.some((line) => line.startsWith("The operator's note:")),
    ).toBe(true);
    expect(logs.some((line) => line.includes('No agent runs here'))).toBe(true);
  });

  it('refuses an operator session for work the acceptable-use policy will not do', async () => {
    const calls: string[] = [];
    const worktreeRoot = await deepTempDir('flowstarter-operator-policy');
    temporaryDirectories.push(worktreeRoot);
    let scanned = '';

    const store: FullSiteBuildJobStore = {
      ...stubStore(calls),
      claim: async (jobId) => ({
        id: jobId,
        projectId: PROJECT_ID,
        kind: 'OPERATOR_EDIT_BUILD',
        projectState: ProjectState.LIVE_SUBSCRIPTION,
        intake,
        brandConfig,
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'Calm Path Therapy, and a page we do not build.',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
        operatorEdit: operatorIntent(),
      }),
      markOperatorEditStarted: async () => {
        calls.push('store:operator-started');
      },
      saveOperatorEditVersion: async () => {
        calls.push('store:version-saved');
        throw new Error('must not reach the version');
      },
    };

    const worktrees = {
      discard: async () => undefined,
      create: async () => ({
        branch: `client/flowstarter-${PROJECT_ID}`,
        path: worktreeRoot,
      }),
      commit: async () => {
        calls.push('worktree:commit');
        throw new Error('must not commit a site the policy refuses');
      },
    } as unknown as SafeGitWorktreeManager;

    const contentPolicy: ContentPolicyScanner = async (input) => {
      scanned = input.text;
      return {
        decision: 'refuse',
        categoryId: 'prohibited.example',
        categoryLabel: 'a business we do not build for',
        evidence: 'The page offers something the policy refuses.',
        evidenceHash: 'sha256:deadbeef',
      };
    };

    await expect(
      new FullSiteBuildWorker(
        store,
        worktrees,
        {} as PiSdkFlowstarterAgents,
        { validate: async () => undefined } as SiteValidator,
        {} as PullRequestPublisher,
        { contentPolicy },
      ).run('job-op-policy'),
    ).rejects.toThrow();

    // An operator's session is the one path that can add a whole new page to a
    // live site, and the agent that wrote it took its instructions from a
    // person rather than from our system prompt. The policy is a rule about
    // the work we do, not about who typed it.
    expect(calls).toContain('store:failed:PROHIBITED_CONTENT');
    expect(calls).not.toContain('worktree:commit');
    expect(calls).not.toContain('store:version-saved');
    // It read the built site's own text, which is the text that would have
    // shipped, rather than the brief or the payload.
    expect(scanned).toContain('a page we do not build');
  });

  it('stops before committing anything when a gate refuses', async () => {
    const calls: string[] = [];
    const worktreeRoot = await deepTempDir('flowstarter-operator-gate');
    temporaryDirectories.push(worktreeRoot);

    const store: FullSiteBuildJobStore = {
      ...stubStore(calls),
      claim: async (jobId) => ({
        id: jobId,
        projectId: PROJECT_ID,
        kind: 'OPERATOR_EDIT_BUILD',
        projectState: ProjectState.HUMAN_QA,
        intake,
        brandConfig,
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content:
              'Calm Path Therapy. Lorem ipsum dolor sit amet, consectetur ' +
              'adipiscing elit, sed do eiusmod tempor incididunt ut labore.',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
        operatorEdit: operatorIntent(),
      }),
      markOperatorEditStarted: async () => {
        calls.push('store:operator-started');
      },
      saveOperatorEditVersion: async () => {
        calls.push('store:version-saved');
        throw new Error('must not reach the version');
      },
    };

    const worktrees = {
      discard: async () => undefined,
      create: async () => ({
        branch: `client/flowstarter-${PROJECT_ID}`,
        path: worktreeRoot,
      }),
      commit: async () => {
        calls.push('worktree:commit');
        throw new Error('must not commit a build a gate refused');
      },
    } as unknown as SafeGitWorktreeManager;

    const validator: SiteValidator = { validate: async () => undefined };

    await expect(
      new FullSiteBuildWorker(
        store,
        worktrees,
        {} as PiSdkFlowstarterAgents,
        validator,
        {} as PullRequestPublisher,
      ).run('job-op-gate'),
    ).rejects.toThrow();

    // The placeholder-copy gate refused, and it refused before anything was
    // committed, saved or published. No repair pass was offered, because the
    // person who wrote this is sitting in the editor and can fix it there.
    expect(calls).toContain('store:failed:PLACEHOLDER_COPY_SHIPPED');
    expect(calls).not.toContain('worktree:commit');
    expect(calls).not.toContain('store:version-saved');
  });
});
