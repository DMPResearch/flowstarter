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
 */
import {
  QUEUED_JOB_STALL_MS,
  RUNNING_JOB_STALL_MS,
} from '@/lib/flowstarter/pipeline/board';

/** The kind of trouble, in the two words the copy is written from. */
export type BuildAttention = 'failed' | 'stalled';

export interface ClientBuildSignal {
  /** The job the client is waiting on. The notice dedupes on it. */
  jobId: string;
  attention: BuildAttention;
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
  now: Date = new Date()
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
