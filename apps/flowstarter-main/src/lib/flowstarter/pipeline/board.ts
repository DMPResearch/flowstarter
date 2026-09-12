/**
 * Turning raw rows into the operator's pipeline board.
 *
 * The board answers one question: which projects are stuck? Everything here is
 * pure so that question is testable without a database — the API layer does the
 * three queries and hands the rows in.
 *
 * "Stuck" is two different failures wearing the same face:
 *   - a job that nobody is running (queued past its dispatch window, or failed),
 *     which is the documented outcome of a Stripe webhook whose worker dispatch
 *     threw and was swallowed; and
 *   - a project that no job is even trying to move, sitting in one state past
 *     the point where a human should have touched it.
 * Both surface as `stalled` with a reason string an operator can act on.
 */
import { quoteMinorFrom } from '@/lib/flowstarter/quote';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { errorCodeLabel, jobKindLabel, projectStateLabel } from './job-labels';
import { PROJECT_STATE_ORDER, asProjectState } from './state-transitions';

/** Event kinds that mark the moment a project entered its current state. */
export const STATE_CHANGE_EVENT_KINDS = [
  'state_changed',
  'state_advanced',
  'state_overridden',
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The ledger status a FULL_SITE_BUILD sits in while its client finishes their
 * brief. The same literal the build worker writes and `deposit-workflow.ts`
 * enqueues with; see the comment on `WAITING_BRIEF` there.
 */
export const WAITING_BRIEF_STATUS = 'waiting_brief';

/**
 * A queued job that has not started within this long is not "waiting its
 * turn", it is unattended. Fifteen minutes is generous for a worker that
 * normally picks up in seconds, and short enough that an operator notices
 * inside one working session.
 */
export const QUEUED_JOB_STALL_MS = 15 * MINUTE;

/** A build that has been `running` this long has almost certainly died mid-flight. */
export const RUNNING_JOB_STALL_MS = 2 * HOUR;

/**
 * How long a project may sit in a state before it wants a human. Tuned to the
 * shape of the work, not to a single number: a client thinking about a preview
 * for a few days is normal, a paid deposit that has not started building
 * within a few hours is not. LIVE_SUBSCRIPTION is terminal and never stalls.
 */
export const STATE_STALL_MS: Readonly<Record<ProjectState, number | null>> = {
  [ProjectState.INTAKE]: 3 * 24 * HOUR,
  [ProjectState.PREVIEW_READY]: 7 * 24 * HOUR,
  [ProjectState.DEPOSIT_PAID]: 4 * HOUR,
  [ProjectState.AGENTS_WORKING]: 24 * HOUR,
  [ProjectState.HUMAN_QA]: 2 * 24 * HOUR,
  [ProjectState.LIVE_SUBSCRIPTION]: null,
};

export interface PipelineWorkspaceRow {
  id: string;
  name: string | null;
  slug?: string | null;
  client_business_name: string | null;
  client_name: string | null;
  client_email: string | null;
  project_state: string;
  deposit_status: string;
  deposit_paid_at: string | null;
  final_value_minor: number | null;
  setup_fee: number | string | null;
  billing_currency: string;
  created_at: string;
  updated_at: string;
}

export interface PipelineJobRow {
  id: string;
  workspace_id: string;
  kind: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  run_after: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_detail: string | null;
}

export interface PipelineEventRow {
  id: string;
  workspace_id: string;
  kind: string;
  actor: string;
  payload: unknown;
  created_at: string;
}

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
  /** Milliseconds since the job last changed hands. */
  ageMs: number;
}

export interface PipelineCard {
  workspaceId: string;
  name: string;
  businessName: string;
  clientEmail: string | null;
  projectState: ProjectState;
  /** Minor units, via the single pricing source. Never re-derived here. */
  quoteMinor: number;
  currency: string;
  depositStatus: string;
  depositPaidAt: string | null;
  /** When the project entered `projectState`, best-effort. */
  stateSince: string;
  timeInStateMs: number;
  latestJob: PipelineJobSummary | null;
  stalled: boolean;
  /** Plain-language reasons, in the order an operator should read them. */
  stallReasons: string[];
  /**
   * Why this project's build has not started, when the answer is "it is
   * waiting for somebody who is not us".
   *
   * Deliberately not a stall reason. A FULL_SITE_BUILD parked on
   * `waiting_brief` is healthy: the deposit is settled, the job exists, and
   * the one thing it needs is a form only the client can fill in. Reported as
   * a stall it is an alarm about our own system for a situation only the
   * client can end, and the support conversation it starts ends with us
   * explaining the board was wrong. Reported as nothing at all it is a build
   * an operator cannot see, which is what shipped. So it is its own field,
   * with the sentence an operator would say to the client.
   */
  waitingOn: 'brief' | null;
  waitingReason: string | null;
  createdAt: string;
}

/** What the board says about a build parked on its client's brief. */
export const WAITING_BRIEF_REASON =
  'Waiting on the client brief. The deposit is settled and the build is ' +
  'booked; it starts by itself the moment the brief is complete, or when an ' +
  'operator overrides it.';

export interface PipelineColumn {
  state: ProjectState;
  cards: PipelineCard[];
  stalledCount: number;
}

export interface PipelineBoard {
  columns: PipelineColumn[];
  total: number;
  stalledCount: number;
  generatedAt: string;
}

/** Latest state-change event per workspace, as an id -> ISO timestamp map. */
export function stateChangedAtByWorkspace(
  events: readonly PipelineEventRow[]
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const event of events) {
    if (!(STATE_CHANGE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
      continue;
    }
    const seen = latest.get(event.workspace_id);
    if (!seen || event.created_at > seen) {
      latest.set(event.workspace_id, event.created_at);
    }
  }
  return latest;
}

/** Newest job per workspace, whatever its kind. */
export function latestJobByWorkspace(
  jobs: readonly PipelineJobRow[]
): Map<string, PipelineJobRow> {
  const latest = new Map<string, PipelineJobRow>();
  for (const job of jobs) {
    const seen = latest.get(job.workspace_id);
    if (!seen || job.created_at > seen.created_at) {
      latest.set(job.workspace_id, job);
    }
  }
  return latest;
}

export function summarizeJob(
  job: PipelineJobRow,
  now: number
): PipelineJobSummary {
  const marker = job.finished_at ?? job.started_at ?? job.created_at;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    errorCode: job.error_code,
    ageMs: Math.max(0, now - Date.parse(marker)),
  };
}

/**
 * Why this project needs a human, if it does. Returns an empty array for a
 * healthy project so callers can treat length as the boolean.
 */
export function stallReasonsFor(input: {
  state: ProjectState;
  timeInStateMs: number;
  job: PipelineJobRow | null;
  now: number;
}): string[] {
  const reasons: string[] = [];
  const { job, now } = input;

  if (job) {
    if (job.status === WAITING_BRIEF_STATUS) {
      // Nothing. See `waitingOn` on PipelineCard: this is a wait, not a stall,
      // and it has no clock. It stops being true when the client finishes
      // their brief, not when a threshold passes.
    } else if (job.status === 'queued') {
      // `run_after` is the earliest the worker should touch it — a backoff
      // window is not a stall, so measure from there and not from creation.
      const due = Math.max(
        Date.parse(job.run_after),
        Date.parse(job.created_at)
      );
      const waiting = now - due;
      if (waiting > QUEUED_JOB_STALL_MS) {
        reasons.push(
          `${jobKindLabel(job.kind)} has been queued for ${formatDuration(
            waiting
          )} without ` +
            'being picked up: dispatch to the worker may have been dropped'
        );
      }
    } else if (job.status === 'running') {
      const started = Date.parse(job.started_at ?? job.created_at);
      const runningFor = now - started;
      if (runningFor > RUNNING_JOB_STALL_MS) {
        reasons.push(
          `${jobKindLabel(job.kind)} has been running for ${formatDuration(
            runningFor
          )}`
        );
      }
    } else if (job.status === 'failed') {
      reasons.push(
        `${jobKindLabel(job.kind)} failed${
          job.error_code ? ` (${errorCodeLabel(job.error_code)})` : ''
        } after ${job.attempt_count}/${job.max_attempts} attempts`
      );
    }
  }

  const budget = STATE_STALL_MS[input.state];
  if (budget !== null && input.timeInStateMs > budget) {
    reasons.push(
      `In ${projectStateLabel(input.state)} for ${formatDuration(
        input.timeInStateMs
      )}`
    );
  }

  return reasons;
}

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return 'less than a minute';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function toPipelineCard(input: {
  workspace: PipelineWorkspaceRow;
  job: PipelineJobRow | null;
  stateSince: string;
  now: number;
}): PipelineCard {
  const { workspace, job, now } = input;
  const state = asProjectState(workspace.project_state) ?? ProjectState.INTAKE;
  const timeInStateMs = Math.max(0, now - Date.parse(input.stateSince));
  const stallReasons = stallReasonsFor({ state, timeInStateMs, job, now });
  const waitingOnBrief = job?.status === WAITING_BRIEF_STATUS;

  return {
    workspaceId: workspace.id,
    name: workspace.name ?? 'Untitled project',
    businessName:
      workspace.client_business_name ||
      workspace.client_name ||
      workspace.name ||
      'Unassigned',
    clientEmail: workspace.client_email,
    projectState: state,
    quoteMinor: quoteMinorFrom(workspace),
    currency: workspace.billing_currency,
    depositStatus: workspace.deposit_status,
    depositPaidAt: workspace.deposit_paid_at,
    stateSince: input.stateSince,
    timeInStateMs,
    latestJob: job ? summarizeJob(job, now) : null,
    stalled: stallReasons.length > 0,
    stallReasons,
    waitingOn: waitingOnBrief ? 'brief' : null,
    waitingReason: waitingOnBrief ? WAITING_BRIEF_REASON : null,
    createdAt: workspace.created_at,
  };
}

/**
 * Groups every workspace into its lifecycle column, newest first inside each.
 *
 * Every state gets a column even when empty — an operator scanning for work
 * should see that DEPOSIT_PAID is empty, not have the column silently vanish
 * and leave them wondering whether it rendered.
 */
export function buildPipelineBoard(input: {
  workspaces: readonly PipelineWorkspaceRow[];
  jobs: readonly PipelineJobRow[];
  events: readonly PipelineEventRow[];
  now?: number;
}): PipelineBoard {
  const now = input.now ?? Date.now();
  const jobByWorkspace = latestJobByWorkspace(input.jobs);
  const stateSinceByWorkspace = stateChangedAtByWorkspace(input.events);

  const columns = new Map<ProjectState, PipelineCard[]>(
    PROJECT_STATE_ORDER.map((state) => [state, []])
  );

  for (const workspace of input.workspaces) {
    const state = asProjectState(workspace.project_state);
    // A row whose project_state the enum does not know is a schema drift bug,
    // not something to render in a made-up column. Skip it loudly.
    if (!state) {
      console.warn(
        `[pipeline] workspace ${workspace.id} has unknown project_state ` +
          `"${workspace.project_state}"; omitted from the board`
      );
      continue;
    }
    const card = toPipelineCard({
      workspace,
      job: jobByWorkspace.get(workspace.id) ?? null,
      // No state-change event yet (nothing has written one for this project)
      // means the row has not moved since it was last touched.
      stateSince:
        stateSinceByWorkspace.get(workspace.id) ??
        workspace.updated_at ??
        workspace.created_at,
      now,
    });
    columns.get(state)?.push(card);
  }

  let total = 0;
  let stalledCount = 0;
  const orderedColumns: PipelineColumn[] = PROJECT_STATE_ORDER.map((state) => {
    const cards = (columns.get(state) ?? []).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    const columnStalled = cards.filter((c) => c.stalled).length;
    total += cards.length;
    stalledCount += columnStalled;
    return { state, cards, stalledCount: columnStalled };
  });

  return {
    columns: orderedColumns,
    total,
    stalledCount,
    generatedAt: new Date(now).toISOString(),
  };
}
