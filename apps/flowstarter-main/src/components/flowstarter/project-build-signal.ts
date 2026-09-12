/**
 * Whether the build a client is waiting on is actually moving.
 *
 * `workspaces.project_state` cannot answer this. When a build fails the worker
 * rolls the project back to DEPOSIT_PAID so a retry can claim it again, which
 * is right for the queue and a lie to the client: the dashboard reads that
 * state and says "your build is booked and about to start", forever, to
 * somebody whose build stopped hours ago. On 2026-09-12 a client who had paid
 * in full read exactly that sentence for the rest of the day.
 *
 * So the client's view gets the same second input the operator's board has
 * had all along: the job row. The thresholds are the board's, imported rather
 * than copied, so an operator and a client can never disagree about whether a
 * build is stuck.
 *
 * The second lie this rule has to avoid arrived with the in-depth brief. The
 * build worker will not start a FULL_SITE_BUILD until the client's brief is
 * ready, so a job can sit in `queued` for days with nothing whatsoever wrong
 * with it. Reported as a stall, that is an alarm about our own system for a
 * situation only the client can end, and the support conversation it starts
 * ends with us explaining that the dashboard was wrong. Hence the third
 * signal, which is calm, names the brief, and is not trouble.
 */
import {
  QUEUED_JOB_STALL_MS,
  RUNNING_JOB_STALL_MS,
  WAITING_BRIEF_STATUS,
} from '@/lib/flowstarter/pipeline/board';

/**
 * What is worth saying about the build, in the words the copy is written from.
 *
 * `waiting_on_brief` is not a kind of trouble and must never be shown as one.
 * The build is queued, healthy, and deliberately not started because the
 * in-depth brief is not finished, which is a sentence about the client and not
 * about us. Before it existed, such a build aged past `QUEUED_JOB_STALL_MS`
 * and was reported as a stall: "Your build has not moved for a while", to
 * somebody whose build was waiting for them. That is a false alarm that
 * generates a support conversation and teaches the client the dashboard lies.
 */
export type BuildAttention = 'failed' | 'stalled' | 'waiting_on_brief';

export interface ClientBuildSignal {
  /** The job the client is waiting on. The notice dedupes on it. */
  jobId: string;
  attention: BuildAttention;
}

/**
 * The second input, beside the job rows.
 *
 * `briefReady` is undefined for a caller that has not read the brief, and an
 * unknown brief is treated as ready: this rule may only ever *suppress* a
 * stall it can prove is really a wait, never invent a wait from a page that
 * did not look.
 */
export interface ClientBuildContext {
  /**
   * Whether the build is allowed to start: the brief is complete, or an
   * operator has overridden it. The same two conditions the worker's claim
   * checks in `apps/build-worker/src/job-store.ts`.
   */
  briefReady?: boolean;
}

/** The columns this rule reads. A subset of `flowstarter_agent_jobs`. */
export interface ClientBuildJobRow {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  run_after?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

/** The build that makes the site. A rebuild is a different promise. */
const BUILD_KIND = 'FULL_SITE_BUILD';

function msSince(value: string | null | undefined, now: number): number {
  if (!value) return 0;
  const at = Date.parse(value);
  return Number.isFinite(at) ? now - at : 0;
}

/**
 * The one thing worth saying about the client's build, or null when there is
 * nothing wrong with it.
 *
 * A cancelled build counts as failed: from the client's side "an operator
 * stopped it" and "it broke" are the same fact, which is that nobody is
 * building their site right now.
 */
export function clientBuildSignal(
  jobs: readonly ClientBuildJobRow[],
  now: Date = new Date(),
  context: ClientBuildContext = {}
): ClientBuildSignal | null {
  const at = now.getTime();
  const builds = jobs
    .filter((job) => job.kind === BUILD_KIND)
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const job = builds[0];
  if (!job) return null;

  if (job.status === 'failed' || job.status === 'canceled') {
    return { jobId: job.id, attention: 'failed' };
  }
  // Before the stall check, and with no threshold of its own: a build waiting
  // on its client is waiting from the moment it is queued, and there is no
  // number of hours after which that becomes a stall. It stops being true when
  // the brief is finished, not when a clock runs out.
  // Two ways to know, and the persisted one wins because it needs no second
  // query: the worker parks the row on `waiting_brief` the first time it
  // refuses to claim it. `briefReady === false` is the caller's own read of
  // the brief and still matters for the window between the deposit landing
  // and a worker first looking at the job.
  if (job.status === WAITING_BRIEF_STATUS) {
    return { jobId: job.id, attention: 'waiting_on_brief' };
  }
  if (job.status === 'queued' && context.briefReady === false) {
    return { jobId: job.id, attention: 'waiting_on_brief' };
  }
  if (
    job.status === 'queued' &&
    msSince(job.run_after ?? job.created_at, at) > QUEUED_JOB_STALL_MS
  ) {
    return { jobId: job.id, attention: 'stalled' };
  }
  if (
    job.status === 'running' &&
    msSince(job.started_at ?? job.created_at, at) > RUNNING_JOB_STALL_MS
  ) {
    return { jobId: job.id, attention: 'stalled' };
  }
  return null;
}
