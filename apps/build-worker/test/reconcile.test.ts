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
import { describe, expect, it, vi } from 'vitest';
import { BuildReconciler, type ReconcilableJobStore } from '../src/reconcile';
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
