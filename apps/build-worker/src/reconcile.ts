/**
 * The durable half of the queue.
 *
 * `BuildQueue` is in-process and starts empty. Everything that puts work into
 * it is an HTTP nudge from flowstarter-main, which means the entire record of
 * "this client has paid and their site is not built yet" lives in a Next.js
 * process's memory for the duration of one `fetch`. Every way that call can be
 * lost -- a restart, a deploy, an unreachable host, an 8-second timeout --
 * leaves a `queued` row that no process will ever look at again.
 *
 * The brief made that worse rather than better. A FULL_SITE_BUILD parks itself
 * on `waiting_brief` when the client has not finished their brief, and the
 * thing that ends that wait is the client, at whatever hour suits them. The
 * app dispatches on the readiness transition, but a dispatch that lands while
 * this service is restarting is a site nobody builds.
 *
 * So this sweeps. It asks the database, not itself, what is runnable: jobs
 * that are queued and due, and jobs whose brief has since become ready. It
 * runs once at startup -- which is the recovery path for everything missed
 * while the process was down -- and then on an interval. The claim is still
 * the atomic compare-and-set in the job store, so a job swept twice, or swept
 * by two workers at once, runs exactly once.
 *
 * Each sweep does two things in order. First it recovers: every `running` row
 * whose lease has died is a build whose worker is gone, and until leases
 * existed such a row was permanently invisible — the claim rule skipped it and
 * the operator board refused to re-dispatch it, so a paid build sat there
 * until somebody noticed. Then it asks what is runnable now, which by that
 * point includes anything recovery just put back.
 *
 * It is deliberately not a scheduler: nothing here decides backoff or picks a
 * retry. Those are the job store's rules and this only ever hands it an id.
 */

import type { EnqueueOutcome } from './queue';

/** What one recovery pass did, for the operator log. */
export interface ReconciliationReport {
  /** Rows that were `running` with a dead lease and are queued again. */
  requeued: string[];
  /** Rows whose site had already shipped; finished without rebuilding. */
  completed: string[];
  /** Rows out of attempts; failed so an operator sees them. */
  abandoned: string[];
}

/** The two things a reconciler needs from a job store. */
export interface ReconcilableJobStore {
  /** Ids of jobs the database says are runnable now. */
  readyForClaim(limit: number): Promise<string[]>;
  /**
   * Hands back every build abandoned by a worker that stopped. Optional so a
   * store without leases still sweeps.
   */
  reconcileStaleLeases?(): Promise<ReconciliationReport>;
}

export interface BuildReconcilerOptions {
  store: ReconcilableJobStore;
  /** Usually `queue.enqueue`. Duplicates are the queue's problem, not ours. */
  enqueue: (jobId: string) => EnqueueOutcome;
  /** How often to sweep. `config.pollIntervalMs`. */
  intervalMs: number;
  /** Most jobs one sweep will look at, so a backlog cannot become a stampede. */
  limit: number;
  onReport?: (message: string) => void;
}

export interface SweepResult {
  found: number;
  enqueued: number;
}

export class BuildReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One sweep at a time: a slow database must not overlap its own sweeps. */
  private sweeping = false;

  constructor(private readonly options: BuildReconcilerOptions) {}

  /**
   * One pass. Never throws: a sweep that cannot read the database is a logged
   * problem, not a reason to take down a worker that is building somebody's
   * site right now.
   */
  async sweep(): Promise<SweepResult> {
    if (this.sweeping) return { found: 0, enqueued: 0 };
    this.sweeping = true;
    try {
      await this.recover();
      const jobIds = await this.options.store.readyForClaim(this.options.limit);
      let enqueued = 0;
      for (const jobId of jobIds) {
        // 'duplicate' means this worker already has it, and 'full' means the
        // host is at capacity and the next sweep will find the job again --
        // the row is still queued, because only a claim changes that.
        if (this.options.enqueue(jobId) === 'accepted') enqueued++;
      }
      if (enqueued > 0) {
        this.options.onReport?.(
          `reconciliation picked up ${enqueued} job(s) nobody had dispatched: ` +
            jobIds.join(', '),
        );
      }
      return { found: jobIds.length, enqueued };
    } catch (error) {
      this.options.onReport?.(
        `reconciliation sweep failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return { found: 0, enqueued: 0 };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Recovers every build whose worker died, and says so.
   *
   * A stranded paid build must never be recovered silently: the line this
   * writes is how an operator learns that a worker stopped mid-build, and how
   * many clients it happened to. Three outcomes, decided by `leases.ts`: the
   * build had already published and only the ledger was behind; it had not,
   * and attempts remain; or its budget is spent and it should read `failed`
   * where somebody can see it rather than loop.
   *
   * A `waiting_brief` row is not one of these. It is not running, nobody holds
   * it, and the thing that ends its wait is a client filling in a form.
   */
  private async recover(): Promise<void> {
    const report = await this.options.store.reconcileStaleLeases?.();
    if (!report) return;
    if (report.completed.length > 0) {
      this.options.onReport?.(
        `reconciliation completed ${report.completed.length} build(s) that had ` +
          'already published before their worker stopped, without rebuilding ' +
          `them: ${report.completed.join(', ')}`,
      );
    }
    if (report.requeued.length > 0) {
      this.options.onReport?.(
        `reconciliation re-queued ${report.requeued.length} build(s) abandoned ` +
          `by a worker that stopped: ${report.requeued.join(', ')}`,
      );
    }
    if (report.abandoned.length > 0) {
      this.options.onReport?.(
        `reconciliation failed ${report.abandoned.length} build(s) abandoned ` +
          'by a worker that stopped, with no attempts left: ' +
          report.abandoned.join(', '),
      );
    }
  }

  /**
   * Sweeps now and then on the interval.
   *
   * The timer is unref'd so it can never be the reason this process stays
   * alive: the HTTP server is what keeps it running, and a worker asked to
   * shut down should not have to wait out a poll.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.options.intervalMs);
    this.timer.unref?.();
    void this.sweep();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Runs `work` with this worker's lease renewed underneath it.
 *
 * The heartbeat is what separates "this build is taking a long time" from
 * "the worker holding this build is gone", and a build legitimately takes
 * minutes. A renewal that comes back false means somebody else now owns the
 * job — the beats were missed for longer than the TTL — so this stops
 * renewing rather than fighting the new holder for the same worktree. It does
 * not cancel the work: the build finishing and being refused by its own
 * compare-and-set is a better outcome than half a site on disk.
 */
export async function withHeartbeat<T>(
  input: {
    store: { heartbeat(jobId: string): Promise<boolean> };
    jobId: string;
    intervalMs: number;
    onLost?: (jobId: string) => void;
    onError?: (jobId: string, error: unknown) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      try {
        const held = await input.store.heartbeat(input.jobId);
        if (!held && !stopped) {
          stopped = true;
          clearInterval(timer);
          input.onLost?.(input.jobId);
        }
      } catch (error) {
        input.onError?.(input.jobId, error);
      }
    })();
  }, input.intervalMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}
