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
 * It is deliberately not a scheduler: nothing here retries a failed build,
 * decides backoff, or touches `running`. Those are the job store's rules and
 * this only ever hands it an id.
 */

import type { EnqueueOutcome } from './queue';

/** The one thing a reconciler needs from a job store. */
export interface ReconcilableJobStore {
  /** Ids of jobs the database says are runnable now. */
  readyForClaim(limit: number): Promise<string[]>;
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
