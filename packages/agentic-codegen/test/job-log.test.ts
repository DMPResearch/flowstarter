/**
 * The running build log.
 *
 * Two things are proved here. First the sink itself: it must batch (one row
 * per ~25 lines, not one per line), keep every body under the table's 4,000
 * character check, and stop rather than fill the table when a build never
 * shuts up. Second the plumbing: a `buildFullSite` pass that traces its work
 * must land as `log` events tagged with who said what, WITHOUT disturbing the
 * phase and reply lines the operator board is built on.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FullSiteBuildWorker,
  JobLogSink,
  ProjectState,
  type JobLogWriter,
  type FullSiteBuildEvent,
  type FullSiteBuildJobStore,
  type PiSdkFlowstarterAgents,
  type PullRequestPublisher,
  type SafeGitWorktreeManager,
  type SiteValidator,
} from '../src';
import type { AgentTraceEntry } from '../src/flowstarter/pi-sdk';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function recorder() {
  const events: FullSiteBuildEvent[] = [];
  return {
    events,
    append: async (event: FullSiteBuildEvent) => {
      events.push(event);
    },
  };
}

describe('JobLogSink', () => {
  it('batches lines into one event per 25 and names the source', async () => {
    const { events, append } = recorder();
    const sink = new JobLogSink({ append, flushIntervalMs: 60_000 });

    for (let i = 0; i < 25; i += 1) {
      sink.write({ source: 'agent', text: `line ${i}` });
    }
    await sink.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('log');
    expect(events[0]?.payload).toEqual({
      source: 'agent',
      lines: 25,
      stream: true,
    });
    expect(events[0]?.body.split('\n')).toHaveLength(25);
    expect(events[0]?.body.startsWith('line 0\n')).toBe(true);
  });

  it('flushes on the character threshold before the line threshold', async () => {
    const { events, append } = recorder();
    const sink = new JobLogSink({ append, flushIntervalMs: 60_000 });

    // Three 600-character lines pass 1,500 characters at the third.
    for (let i = 0; i < 3; i += 1) {
      sink.write({ source: 'machine', text: 'x'.repeat(600) });
    }
    await sink.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ source: 'machine', lines: 3 });
  });

  it('flushes on its own after the interval, without being asked', async () => {
    const { events, append } = recorder();
    const sink = new JobLogSink({ append, flushIntervalMs: 20 });

    sink.write({ source: 'machine', text: 'still working' });
    expect(events).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(events).toHaveLength(1);
    expect(events[0]?.body).toBe('still working');
  });

  it('never mixes two sources into one event', async () => {
    const { events, append } = recorder();
    const sink = new JobLogSink({ append, flushIntervalMs: 60_000 });

    sink.write({ source: 'agent', text: 'I will edit the hero' });
    sink.write({ source: 'tool', text: 'write_file src/pages/index.astro' });
    sink.write({ source: 'agent', text: 'Done' });
    await sink.flush();

    expect(events.map((event) => event.payload?.source)).toEqual([
      'agent',
      'tool',
      'agent',
    ]);
  });

  it('keeps every body under the 4,000 character table check', async () => {
    const { events, append } = recorder();
    // Thresholds raised past the body cap on purpose: the cap, not the
    // threshold, is what has to hold.
    const sink = new JobLogSink({
      append,
      flushIntervalMs: 60_000,
      maxLines: 10_000,
      maxChars: 1_000_000,
    });

    for (let i = 0; i < 40; i += 1) {
      sink.write({ source: 'machine', text: 'y'.repeat(900) });
    }
    // One line longer than any body could ever be.
    sink.write({ source: 'machine', text: 'z'.repeat(9_000) });
    await sink.flush();

    expect(events.length).toBeGreaterThan(1);
    for (const event of events) expect(event.body.length).toBeLessThan(4_000);
    expect(
      events.some((event) => event.body.includes('[line truncated]')),
    ).toBe(true);
  });

  it('splits a multi-line write and drops blank lines', async () => {
    const { events, append } = recorder();
    const sink = new JobLogSink({ append, flushIntervalMs: 60_000 });

    sink.write({ source: 'machine', text: 'first\n\n  \nsecond\n' });
    await sink.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.body).toBe('first\nsecond');
    expect(events[0]?.payload).toMatchObject({ lines: 2 });
  });

  it('stops at its event budget and says so once', async () => {
    const { events, append } = recorder();
    const sink = new JobLogSink({
      append,
      flushIntervalMs: 60_000,
      maxLines: 1,
      maxEvents: 3,
    });

    for (let i = 0; i < 10; i += 1) {
      sink.write({ source: 'agent', text: `line ${i}` });
    }
    await sink.flush();

    expect(events).toHaveLength(4);
    expect(sink.eventCount).toBe(3);
    expect(events.at(-1)?.body).toContain('log truncated');
    expect(events.at(-1)?.payload).toMatchObject({ truncated: true });

    // Nothing after the truncation line, no matter how much more arrives.
    sink.write({ source: 'agent', text: 'ignored' });
    await sink.flush();
    expect(events).toHaveLength(4);
  });

  it('never lets a failed append reach the build', async () => {
    const events: FullSiteBuildEvent[] = [];
    const sink = new JobLogSink({
      append: async (event) => {
        events.push(event);
        throw new Error('the events table is unhappy');
      },
      flushIntervalMs: 60_000,
    });

    sink.write({ source: 'machine', text: 'a line' });
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });
});

// ─── The worker end of it ───────────────────────────────────────────────────

function intake() {
  return {
    projectId: '0f4e1088-8d8f-4f18-83b1-406cc292b23c',
    business: {
      name: 'Calm Path Therapy',
      niche: 'Therapy practice',
      location: 'Cluj-Napoca, Romania',
      description: 'Calm, practical therapy for founders and creatives.',
      targetAudience: 'Founders and creative professionals',
      primaryGoal: 'bookings' as const,
    },
    socialMedia: [],
    locale: 'en-RO',
    submittedAt: '2026-08-11T10:00:00.000Z',
    consent: {
      publicProfileAnalysis: true,
      acceptedAt: '2026-08-11T10:00:00.000Z',
    },
  };
}

describe('a full build reports the agents running work', () => {
  it('logs the trace as agent and tool lines, and leaves the phases alone', async () => {
    const projectId = intake().projectId;
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'flowstarter-trace-'));
    temporaryDirectories.push(worktreeRoot);

    const events: FullSiteBuildEvent[] = [];
    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'FULL_SITE_BUILD',
        projectState: ProjectState.DEPOSIT_PAID,
        intake: intake(),
        brandConfig: {} as never,
        approvedPreviewFiles: [
          {
            path: 'src/content/site.md',
            content: 'Approved preview',
            type: 'file',
          },
        ],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async () => undefined,
      appendEvent: async (_jobId, event) => {
        events.push(event);
      },
    };
    const worktrees = {
      create: async () => ({
        branch: `client/flowstarter-${projectId}`,
        path: worktreeRoot,
      }),
      commit: async () => 'abc123',
    } as unknown as SafeGitWorktreeManager;
    const agents = {
      buildFullSite: async (input: {
        onTrace?: (entry: AgentTraceEntry) => void;
      }) => {
        input.onTrace?.({
          kind: 'text',
          text: 'Reading the approved preview.',
        });
        input.onTrace?.({
          kind: 'tool_call',
          text: 'read_file src/content/site.md',
          tool: 'read_file',
          path: 'src/content/site.md',
        });
        input.onTrace?.({
          kind: 'tool_result',
          text: 'read_file -> 1.2 KB returned',
          tool: 'read_file',
        });
        input.onTrace?.({
          kind: 'thinking',
          text: 'The hero needs a rewrite.',
        });
        return { summary: 'Full site built', changedPaths: ['src/pages/x'] };
      },
    } as unknown as PiSdkFlowstarterAgents;
    const validator: SiteValidator = { validate: async () => undefined };
    const pullRequests: PullRequestPublisher = {
      create: async () => ({
        pullRequestUrl: 'https://example.test/pr/1',
        stagingUrl: 'https://staging.test',
      }),
    };

    let registered: string | null = null;
    await new FullSiteBuildWorker(
      store,
      worktrees,
      agents,
      validator,
      pullRequests,
      { onJobLog: (jobId) => (registered = jobId) },
    ).run('job-trace');

    expect(registered).toBe('job-trace');

    const logs = events.filter(
      (event) => event.kind === 'log' && event.payload?.stream === true,
    );
    const bySource = (source: string) =>
      logs
        .filter((event) => event.payload?.source === source)
        .flatMap((event) => event.body.split('\n'));

    expect(bySource('agent')).toEqual([
      'Reading the approved preview.',
      '(thinking) The hero needs a rewrite.',
    ]);
    expect(bySource('tool')).toEqual([
      'read_file src/content/site.md',
      'read_file -> 1.2 KB returned',
    ]);

    // The board's own lines are exactly what they were before the log existed.
    expect(
      events.filter((event) => event.kind === 'phase').map((e) => e.body),
    ).toEqual([
      'Preparing a clean worktree',
      'Materializing the approved preview',
      'Agents expanding the site',
      'Checking the build',
      'Checking the site matches the brief',
      'Checking for placeholder copy',
      'Committing the site',
      'Publishing for review',
      'Handed to human QA',
    ]);
    expect(
      events.filter((event) => event.kind === 'reply').map((e) => e.body),
    ).toEqual(['Full site built']);
    // The agent's work is on the record before the words that conclude it.
    expect(events.findIndex((e) => e.kind === 'reply')).toBeGreaterThan(
      events.findIndex((e) => e.payload?.source === 'tool'),
    );
  });

  it('logs a rebuild without an agent pass, and still flushes at the end', async () => {
    const projectId = intake().projectId;
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'flowstarter-rebuild-'));
    temporaryDirectories.push(worktreeRoot);

    const events: FullSiteBuildEvent[] = [];
    const store: FullSiteBuildJobStore = {
      claim: async (jobId) => ({
        id: jobId,
        projectId,
        kind: 'SITE_REBUILD',
        projectState: ProjectState.HUMAN_QA,
        intake: intake(),
        brandConfig: {} as never,
        approvedPreviewFiles: [
          { path: 'src/content/site.md', content: 'Edited', type: 'file' },
        ],
        requiredIntegrations: [],
      }),
      markAgentWorking: async () => undefined,
      markRebuildStarted: async () => undefined,
      markRebuilt: async () => undefined,
      markHumanQa: async () => undefined,
      markFailed: async () => undefined,
      appendEvent: async (_jobId, event) => {
        events.push(event);
      },
    };
    const worktrees = {
      create: async () => ({
        branch: `client/flowstarter-${projectId}`,
        path: worktreeRoot,
      }),
      commit: async () => 'def456',
    } as unknown as SafeGitWorktreeManager;

    let log: JobLogWriter | null = null;
    const validator: SiteValidator = {
      validate: async () => {
        // Stands in for the real validator's onOutput, which reaches the sink
        // through the worker process's job context.
        log?.write({ source: 'machine', text: 'Running pnpm run build' });
      },
    };

    await new FullSiteBuildWorker(
      store,
      worktrees,
      {} as PiSdkFlowstarterAgents,
      validator,
      {
        create: async () => ({
          pullRequestUrl: 'https://example.test/pr/2',
          stagingUrl: 'https://staging.test',
        }),
      },
      { onJobLog: (_jobId, writer) => (log = writer) },
    ).run('job-rebuild');

    const machine = events.filter(
      (event) => event.payload?.source === 'machine',
    );
    expect(machine.map((event) => event.body)).toEqual([
      'Running pnpm run build',
    ]);
    expect(
      events.filter((event) => event.kind === 'phase').map((e) => e.body),
    ).toEqual([
      'Preparing a clean worktree',
      'Materializing the published edit',
      'Checking the build',
      'Committing the site',
      'Publishing',
      'Live',
    ]);
  });
});
