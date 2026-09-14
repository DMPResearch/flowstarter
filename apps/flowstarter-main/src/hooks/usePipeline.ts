'use client';

/**
 * Client access to the operator pipeline API.
 *
 * Reads point at `/api/admin/*` for the same reason every other operator hook
 * does — that is the tree the `/admin/dashboard` pages are served from. The
 * `/api/team/*` mirror is the same handler, so switching base paths is a
 * one-line change if the pages ever move.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
// Deep import, not the package root: the root re-exports the Pi SDK and the
// whole generation pipeline, and this module is imported by browser code.
import {
  isAgentActivityEvent,
  type AgentActivityEvent,
} from '@flowstarter/agentic-codegen/src/flowstarter/activity';

export interface PipelineJobSummary {
  id: string;
  kind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  ageMs: number;
}

export interface PipelineCard {
  workspaceId: string;
  name: string;
  businessName: string;
  clientEmail: string | null;
  projectState: ProjectState;
  quoteMinor: number;
  currency: string;
  depositStatus: string;
  depositPaidAt: string | null;
  stateSince: string;
  timeInStateMs: number;
  latestJob: PipelineJobSummary | null;
  stalled: boolean;
  stallReasons: string[];
  createdAt: string;
}

export interface PipelineBoard {
  columns: Array<{
    state: ProjectState;
    cards: PipelineCard[];
    stalledCount: number;
  }>;
  total: number;
  stalledCount: number;
  generatedAt: string;
}

export interface PipelineJobDetail extends PipelineJobSummary {
  errorDetail: string | null;
  runAfter: string;
  canRedispatch: boolean;
  canCancel: boolean;
  /** The worker's last reported phase, in its own plain words. */
  latestPhase: string | null;
  /** The newest agent reply, trimmed to a headline. */
  lastReply: string | null;
}

export interface PipelineEvent {
  id: string;
  kind: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface PipelineDetail {
  project: PipelineCard;
  allowedTransitions: ProjectState[];
  jobs: PipelineJobDetail[];
  events: PipelineEvent[];
}

/**
 * Every kind of row one build writes. `activity` is a structured step of the
 * agent timeline rather than a line of prose, so the conversation endpoint
 * leaves it out of its default answer and `useBuildJobActivity` asks for it
 * by name; it is in this union because the row is still a build event and a
 * caller reading one has to be able to tell.
 */
export type BuildJobEventKind = 'phase' | 'log' | 'note' | 'reply' | 'activity';

export interface BuildJobEvent {
  id: string;
  kind: BuildJobEventKind;
  actor: string;
  body: string;
  payload: unknown;
  createdAt: string;
}

export interface BuildJobFeed {
  job: PipelineJobSummary & {
    errorDetail: string | null;
    latestPhase: string | null;
    acceptsNotes: boolean;
  };
  events: BuildJobEvent[];
}

export const buildJobFeedQueryKey = (
  id: string | undefined,
  jobId: string | undefined
) => ['pipeline-job-feed', id, jobId] as const;

export const pipelineBoardQueryKey = ['pipeline-board'] as const;
export const pipelineDetailQueryKey = (id: string | undefined) =>
  ['pipeline-detail', id] as const;

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(body?.error || fallback);
}

export function usePipelineBoard() {
  return useQuery({
    queryKey: pipelineBoardQueryKey,
    queryFn: async (): Promise<PipelineBoard> => {
      const res = await fetch('/api/admin/projects/pipeline', {
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Failed to load the pipeline');
      return res.json();
    },
    // A stalled job is a time-sensitive fact; a board that is a minute stale is
    // worse than one extra query.
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function usePipelineDetail(id: string | undefined) {
  return useQuery({
    queryKey: pipelineDetailQueryKey(id),
    enabled: Boolean(id),
    queryFn: async (): Promise<PipelineDetail> => {
      const res = await fetch(`/api/admin/projects/${id}/pipeline`, {
        cache: 'no-store',
      });
      if (!res.ok) await readError(res, 'Failed to load the project pipeline');
      return res.json();
    },
    staleTime: 10_000,
    retry: 1,
  });
}

function usePipelineAction<TBody, TResult>(
  id: string | undefined,
  path: string,
  fallbackError: string
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody): Promise<TResult> => {
      if (!id) throw new Error('Missing project id');
      const res = await fetch(`/api/admin/projects/${id}/pipeline/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) await readError(res, fallbackError);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipelineDetailQueryKey(id) });
      qc.invalidateQueries({ queryKey: pipelineBoardQueryKey });
      // The state override writes `project_state`, which the project detail
      // header and the projects list both render.
      qc.invalidateQueries({ queryKey: ['team-project', id] });
      qc.invalidateQueries({ queryKey: ['team-projects'] });
    },
  });
}

export function useRedispatchBuild(id: string | undefined) {
  return usePipelineAction<
    { jobId?: string; reason?: string },
    {
      job: { id: string; status: string };
      dispatched: boolean;
      dispatchError: string | null;
    }
  >(id, 'redispatch', 'Failed to re-dispatch the build');
}

export function useOverrideProjectState(id: string | undefined) {
  return usePipelineAction<
    { toState: ProjectState; reason: string },
    { project: { projectState: ProjectState; previousState: ProjectState } }
  >(id, 'state', 'Failed to change the project state');
}

export function useCancelPipelineJob(id: string | undefined) {
  return usePipelineAction<
    { jobId: string; reason: string },
    { job: { id: string; status: string } }
  >(id, 'cancel-job', 'Failed to cancel the job');
}

/** How often a live build's conversation is re-read. */
export const BUILD_FEED_LIVE_INTERVAL_MS = 5_000;

/**
 * The conversation of one build. Polls while the job is queued or running;
 * a finished job's feed is read once. Polling rather than SSE because the
 * worker writes to Supabase from another host, and the board already polls.
 */
export function useBuildJobFeed(
  id: string | undefined,
  jobId: string | undefined,
  options: { live: boolean }
) {
  return useQuery({
    queryKey: buildJobFeedQueryKey(id, jobId),
    enabled: Boolean(id && jobId),
    queryFn: async (): Promise<BuildJobFeed> => {
      const res = await fetch(
        `/api/admin/projects/${id}/pipeline/jobs/${jobId}/events`,
        { cache: 'no-store' }
      );
      if (!res.ok)
        await readError(res, 'Failed to load the build conversation');
      return res.json();
    },
    staleTime: 2_000,
    refetchInterval: options.live ? BUILD_FEED_LIVE_INTERVAL_MS : false,
    retry: 1,
  });
}

export const buildJobActivityQueryKey = (
  id: string | undefined,
  jobId: string | undefined
) => ['pipeline-job-activity', id, jobId] as const;

/**
 * The agent's own timeline for one build: the steps it took, in order.
 *
 * The same endpoint as the conversation, asked a different question. Activity
 * rows are excluded from that feed by default -- there are hundreds per build
 * and the conversation is prose -- so this opts back in with `?kinds=activity`
 * and unwraps `payload.activity` from each row.
 *
 * Rows are validated on the way in and a malformed one is dropped rather than
 * repaired: a repaired step is an invented step, and this timeline only ever
 * shows work that actually happened. `detail` survives, because the operator
 * reading this is the person who has to go and open the file it names.
 */
export function useBuildJobActivity(
  id: string | undefined,
  jobId: string | undefined,
  options: { live: boolean }
) {
  return useQuery({
    queryKey: buildJobActivityQueryKey(id, jobId),
    enabled: Boolean(id && jobId),
    queryFn: async (): Promise<AgentActivityEvent[]> => {
      const res = await fetch(
        `/api/admin/projects/${id}/pipeline/jobs/${jobId}/events?kinds=activity`,
        { cache: 'no-store' }
      );
      if (!res.ok) await readError(res, 'Failed to load the build activity');
      const body = (await res.json()) as {
        events?: Array<{ payload?: unknown }>;
      };
      return (body.events ?? [])
        .map(
          (event) => (event.payload as { activity?: unknown } | null)?.activity
        )
        .filter(isAgentActivityEvent);
    },
    staleTime: 2_000,
    refetchInterval: options.live ? BUILD_FEED_LIVE_INTERVAL_MS : false,
    retry: 1,
  });
}

/**
 * The three streamed sources the log route promises for build output. The
 * route also flattens in the build's other event kinds (phase, note, reply)
 * tagged by their own kind, so a line's actual `source` is any string, not
 * only these three — this type names the ones the filter chips group by.
 */
export type BuildLogSource = 'agent' | 'tool' | 'machine';

export interface BuildLogLine {
  at: string;
  source: string;
  text: string;
}

export interface BuildJobLog {
  job: { id: string; kind: string; status: string };
  lines: BuildLogLine[];
}

export const buildJobLogQueryKey = (
  id: string | undefined,
  jobId: string | undefined
) => ['pipeline-job-log', id, jobId] as const;

/** The same endpoint the query reads, switched to a plain-text download. */
export function buildJobLogDownloadUrl(id: string, jobId: string): string {
  return `/api/admin/projects/${id}/pipeline/jobs/${jobId}/log?format=text`;
}

/**
 * The full build log: every line the agents and the machine wrote, not just
 * the conversation's highlights. Polls while the job is live, same cadence as
 * the conversation feed, so the two never drift out of sync with each other.
 *
 * The log route can lag the rest of this feature (it is being built
 * alongside this hook), and even once it exists a build that predates it has
 * nothing to serve — both a missing route and a dropped connection are read
 * as "no log yet" rather than as an error, so the panel shows a calm empty
 * state instead of a scary one.
 */
export function useBuildJobLog(
  id: string | undefined,
  jobId: string | undefined,
  options: { live: boolean }
) {
  return useQuery({
    queryKey: buildJobLogQueryKey(id, jobId),
    enabled: Boolean(id && jobId),
    queryFn: async (): Promise<BuildJobLog | null> => {
      let res: Response;
      try {
        res = await fetch(
          `/api/admin/projects/${id}/pipeline/jobs/${jobId}/log`,
          { cache: 'no-store' }
        );
      } catch {
        // Offline, DNS hiccup, the route not deployed yet — none of that is
        // the operator's problem to read as a failure.
        return null;
      }
      if (res.status === 404) return null;
      if (!res.ok) await readError(res, 'Failed to load the build log');
      return res.json();
    },
    staleTime: 2_000,
    refetchInterval: options.live ? BUILD_FEED_LIVE_INTERVAL_MS : false,
    retry: 1,
  });
}

export function useSendBuildNote(
  id: string | undefined,
  jobId: string | undefined
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      message: string;
    }): Promise<{
      event: BuildJobEvent;
      delivery: 'next_pass' | 'next_attempt' | 'build_start';
    }> => {
      if (!id || !jobId) throw new Error('Missing job id');
      const res = await fetch(
        `/api/admin/projects/${id}/pipeline/jobs/${jobId}/notes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) await readError(res, 'Failed to send the note');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: buildJobFeedQueryKey(id, jobId) });
      qc.invalidateQueries({ queryKey: pipelineDetailQueryKey(id) });
    },
  });
}
