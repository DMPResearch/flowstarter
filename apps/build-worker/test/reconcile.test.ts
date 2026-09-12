/**
 * The durable half of the queue.
 *
 * `BuildQueue` starts empty on every boot, and the only thing that ever put
 * work into it was an HTTP nudge from flowstarter-main. So the whole record of
 * "this client has paid and their site is not built yet" survived exactly as
 * long as one `fetch`: a restart, a deploy, an unreachable host or an 8-second
 * timeout left a row nobody would look at again. The brief made it worse --
 * the thing that ends a `waiting_brief` wait is a client filling in a form at
 * whatever hour suits them, and a dispatch that lands while this process is
 * restarting is a site nobody builds.
 *
 * These tests pin the four properties that make the sweep safe to leave
 * running unattended: it asks the database rather than itself, it never
 * throws, it never overlaps its own sweeps, and its timer can never be the
 * reason the process stays alive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BuildReconciler,
  withHeartbeat,
  type ReconcilableJobStore,
} from '../src/reconcile';
import type { EnqueueOutcome } from '../src/queue';

function reconciler(input: {
  ready: string[][] | (() => Promise<string[]>);
  enqueue?: (jobId: string) => EnqueueOutcome;
  reports?: string[];
  intervalMs?: number;
}) {
  const batches = Array.isArray(input.ready) ? [...input.ready] : null;
  const store: ReconcilableJobStore = {
    readyForClaim: batches
      ? async () => batches.shift() ?? []
      : (input.ready as () => Promise<string[]>),
  };
  const enqueued: string[] = [];
  return {
    enqueued,
    reconciler: new BuildReconciler({
      store,
      enqueue: (jobId) => {
        enqueued.push(jobId);
        return input.enqueue ? input.enqueue(jobId) : 'accepted';
      },
      intervalMs: input.intervalMs ?? 60_000,
      limit: 25,
      ...(input.reports
        ? { onReport: (message: string) => input.reports?.push(message) }
        : {}),
    }),
  };
}

describe('BuildReconciler', () => {
  it('enqueues every job the database says is runnable', async () => {
    const reports: string[] = [];
    const { reconciler: sweeper, enqueued } = reconciler({
      ready: [['job-a', 'job-b']],
      reports,
    });

    await expect(sweeper.sweep()).resolves.toEqual({ found: 2, enqueued: 2 });
    expect(enqueued).toEqual(['job-a', 'job-b']);
    expect(reports.join(' ')).toContain('nobody had dispatched');
  });

  it('counts only what the queue actually accepted', async () => {
    // 'duplicate' is this worker already having the job; 'full' is the host at
    // capacity, and the row is still queued so the next sweep finds it again.
    const { reconciler: sweeper } = reconciler({
      ready: [['job-a', 'job-b', 'job-c']],
      enqueue: (jobId) =>
        jobId === 'job-a'
          ? 'accepted'
          : jobId === 'job-b'
            ? 'duplicate'
            : 'full',
    });

    await expect(sweeper.sweep()).resolves.toEqual({ found: 3, enqueued: 1 });
  });

  it('reports a database failure instead of taking the worker down', async () => {
    const reports: string[] = [];
    const { reconciler: sweeper, enqueued } = reconciler({
      ready: async () => {
        throw new Error('supabase is unreachable');
      },
      reports,
    });

    await expect(sweeper.sweep()).resolves.toEqual({ found: 0, enqueued: 0 });
    expect(enqueued).toEqual([]);
    expect(reports.join(' ')).toContain('supabase is unreachable');
  });

  it('never overlaps its own sweeps', async () => {
    let inFlight = 0;
    let overlapped = false;
    let calls = 0;
    const { reconciler: sweeper } = reconciler({
      ready: async () => {
        calls++;
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return [];
      },
    });

    await Promise.all([sweeper.sweep(), sweeper.sweep(), sweeper.sweep()]);
    expect(overlapped).toBe(false);
    // The two that arrived while the first was running returned immediately
    // rather than queueing another read.
    expect(calls).toBe(1);
  });

  it('sweeps immediately on start, then on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { reconciler: sweeper, enqueued } = reconciler({
        ready: [['job-a'], ['job-b'], ['job-c']],
        intervalMs: 1_000,
      });

      sweeper.start();
      // Startup reconciliation: this is the recovery path for everything that
      // was dispatched while the process was down.
      await vi.advanceTimersByTimeAsync(0);
      expect(enqueued).toEqual(['job-a']);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(enqueued).toEqual(['job-a', 'job-b']);

      sweeper.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(enqueued).toEqual(['job-a', 'job-b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starting twice does not double the interval', async () => {
    vi.useFakeTimers();
    try {
      const { reconciler: sweeper, enqueued } = reconciler({
        ready: [['job-a'], ['job-b'], ['job-c'], ['job-d']],
        intervalMs: 1_000,
      });
      sweeper.start();
      sweeper.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(enqueued).toEqual(['job-a', 'job-b']);
      sweeper.stop();
      // A second stop is a no-op rather than an error, because SIGTERM and
      // SIGINT can both arrive.
      expect(() => sweeper.stop()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The recovery half of the same sweep.
 *
 * A `running` row whose lease has stopped being renewed is a build whose
 * worker is gone. Until leases existed nothing ever looked at such a row
 * again: the claim rule skipped `running` outright and the operator board
 * refused to re-dispatch it, so a paid build sat there until a client asked
 * where their site was. The rules that classify one live in `leases.test.ts`;
 * these pin what the loop does with the answer.
 */
describe('BuildReconciler recovery', () => {
  function emptyReport() {
    return { requeued: [], completed: [], abandoned: [] };
  }

  function recovering(input: {
    report?: () => Promise<{
      requeued: string[];
      completed: string[];
      abandoned: string[];
    }>;
    ready?: string[];
    reports: string[];
  }) {
    const store: ReconcilableJobStore = {
      readyForClaim: async () => input.ready ?? [],
      reconcileStaleLeases: input.report ?? (async () => emptyReport()),
    };
    const enqueued: string[] = [];
    return {
      enqueued,
      reconciler: new BuildReconciler({
        store,
        enqueue: (jobId) => {
          enqueued.push(jobId);
          return 'accepted';
        },
        intervalMs: 60_000,
        limit: 25,
        onReport: (message) => input.reports.push(message),
      }),
    };
  }

  it('says nothing when nothing was abandoned', async () => {
    const reports: string[] = [];
    const { reconciler: sweeper } = recovering({ reports });

    await sweeper.sweep();

    expect(reports.join('\n')).not.toContain('reconciliation re-queued');
    expect(reports.join('\n')).not.toContain('reconciliation completed');
  });

  it('names every recovered build, because a stranded paid build is news', async () => {
    const reports: string[] = [];
    const { reconciler: sweeper } = recovering({
      reports,
      report: async () => ({
        requeued: ['job-a'],
        completed: ['job-b'],
        abandoned: ['job-c'],
      }),
    });

    await sweeper.sweep();

    const said = reports.join('\n');
    expect(said).toContain('already published before their worker stopped');
    expect(said).toContain('job-b');
    expect(said).toContain('re-queued 1 build(s) abandoned by a worker');
    expect(said).toContain('job-a');
    expect(said).toContain('with no attempts left');
    expect(said).toContain('job-c');
  });

  it('recovers before it asks what is runnable, so the same sweep picks it up', async () => {
    // Order matters: a build re-queued by recovery is `queued` by the time
    // readyForClaim runs, so it is running again within one sweep rather than
    // waiting out another poll interval.
    const order: string[] = [];
    const store: ReconcilableJobStore = {
      reconcileStaleLeases: async () => {
        order.push('recover');
        return { requeued: ['job-a'], completed: [], abandoned: [] };
      },
      readyForClaim: async () => {
        order.push('ready');
        return ['job-a'];
      },
    };
    const enqueued: string[] = [];
    const sweeper = new BuildReconciler({
      store,
      enqueue: (jobId) => {
        enqueued.push(jobId);
        return 'accepted';
      },
      intervalMs: 60_000,
      limit: 25,
    });

    await sweeper.sweep();

    expect(order).toEqual(['recover', 'ready']);
    expect(enqueued).toEqual(['job-a']);
  });

  it('still sweeps for a store that has no leases at all', async () => {
    // `reconcileStaleLeases` is optional on the interface, and a store without
    // it must not turn every sweep into a crash.
    const store: ReconcilableJobStore = {
      readyForClaim: async () => ['job-a'],
    };
    const enqueued: string[] = [];
    const sweeper = new BuildReconciler({
      store,
      enqueue: (jobId) => {
        enqueued.push(jobId);
        return 'accepted';
      },
      intervalMs: 60_000,
      limit: 25,
    });

    await expect(sweeper.sweep()).resolves.toEqual({ found: 1, enqueued: 1 });
    expect(enqueued).toEqual(['job-a']);
  });

  it('reports a recovery that could not read the database, and sweeps on', async () => {
    const reports: string[] = [];
    const { reconciler: sweeper } = recovering({
      reports,
      report: async () => {
        throw new Error('connection reset');
      },
    });

    // Never throws: a worker building somebody's site right now must not be
    // taken down because one recovery query failed.
    await expect(sweeper.sweep()).resolves.toEqual({ found: 0, enqueued: 0 });
    expect(reports.join('\n')).toContain('connection reset');
  });
});

/**
 * The heartbeat, which is what separates "this build is taking a long time"
 * from "the worker holding this build is gone". A full build legitimately
 * takes minutes; without a renewal, recovery above could not tell the two
 * apart without waiting out a TTL longer than any build.
 */
describe('withHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function beating(heartbeat: () => Promise<boolean>) {
    return { heartbeat: vi.fn(heartbeat) };
  }

  it('renews the lease for as long as the build runs, then stops', async () => {
    const store = beating(async () => true);
    let finish: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const running = withHeartbeat(
      { store, jobId: 'job-a', intervalMs: 1_000 },
      () => work,
    );
    await vi.advanceTimersByTimeAsync(3_500);
    expect(store.heartbeat).toHaveBeenCalledTimes(3);

    finish();
    await running;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(3);
  });

  it('stops renewing once another worker owns the job, without killing the build', async () => {
    // Deliberately not a cancellation: half a site on disk is worse than a
    // build that finishes and has its own compare-and-set refuse the result.
    const lost: string[] = [];
    const store = beating(async () => false);
    let finish: () => void = () => {};
    const work = new Promise<string>((resolve) => {
      finish = () => resolve('done anyway');
    });

    const running = withHeartbeat(
      {
        store,
        jobId: 'job-a',
        intervalMs: 1_000,
        onLost: (id) => lost.push(id),
      },
      () => work,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(lost).toEqual(['job-a']);
    expect(store.heartbeat).toHaveBeenCalledTimes(1);

    finish();
    await expect(running).resolves.toBe('done anyway');
  });

  it('reports a failed beat and keeps trying', async () => {
    const errors: string[] = [];
    const store = beating(async () => {
      throw new Error('connection reset');
    });
    let finish: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const running = withHeartbeat(
      {
        store,
        jobId: 'job-a',
        intervalMs: 1_000,
        onError: (id) => errors.push(id),
      },
      () => work,
    );
    await vi.advanceTimersByTimeAsync(2_500);
    expect(errors).toEqual(['job-a', 'job-a']);

    finish();
    await running;
  });

  it('stops renewing even when the build throws', async () => {
    const store = beating(async () => true);
    await expect(
      withHeartbeat({ store, jobId: 'job-a', intervalMs: 1_000 }, async () => {
        throw new Error('validation failed');
      }),
    ).rejects.toThrow('validation failed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.heartbeat).not.toHaveBeenCalled();
  });
});
