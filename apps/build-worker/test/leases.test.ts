/**
 * The lease rules, asserted as rules: a row, a clock, an answer.
 *
 * The defect these exist for is specific. A worker claimed a paid build, wrote
 * `running`, and was killed. Nothing ever looked at that row again: the claim
 * rule excluded `running`, so a restarted worker walked past it, and the
 * operator board refused to re-dispatch it for the same reason. Every case
 * below is a variation on "who still holds this, and what happened before they
 * stopped".
 */
import { describe, expect, it } from 'vitest';
import {
  attemptBudget,
  backoffMs,
  claimVerdict,
  isDue,
  leaseDeadline,
  leaseHeld,
  leaseOwner,
  nextRunAfter,
  publishedResult,
  staleLeaseAction,
  type LeasedJobRow,
} from '../src/leases';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const TTL = 120_000;
const RULES = { now: NOW, maxAttempts: 3, leaseTtlMs: TTL };

function row(overrides: Partial<LeasedJobRow> = {}): LeasedJobRow {
  return {
    id: 'f2a1c9d0-0000-4000-8000-000000000001',
    kind: 'FULL_SITE_BUILD',
    status: 'queued',
    attempt_count: 0,
    ...overrides,
  };
}

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('claimVerdict', () => {
  it('claims a queued build nobody holds', () => {
    expect(claimVerdict(row(), RULES)).toEqual({
      claimable: true,
      recovered: false,
    });
  });

  it('refuses a job another worker is still checking in on', () => {
    const held = row({
      status: 'running',
      leased_by: 'builder-2:41:aa',
      lease_expires_at: iso(60_000),
    });
    expect(claimVerdict(held, RULES)).toEqual({
      claimable: false,
      reason: 'leased',
    });
  });

  it('recovers a running build whose worker stopped checking in', () => {
    // The defect, in one assertion: before leases this row was permanently
    // unclaimable and the client's paid build never happened.
    const abandoned = row({
      status: 'running',
      attempt_count: 1,
      leased_by: 'builder-1:9:ff',
      lease_expires_at: iso(-1_000),
    });
    expect(claimVerdict(abandoned, RULES)).toEqual({
      claimable: true,
      recovered: true,
    });
  });

  it('dates a running row claimed before leases existed from its start time', () => {
    const legacy = row({ status: 'running', started_at: iso(-TTL - 1) });
    expect(claimVerdict(legacy, RULES)).toEqual({
      claimable: true,
      recovered: true,
    });
    const recent = row({ status: 'running', started_at: iso(-1_000) });
    expect(claimVerdict(recent, RULES)).toEqual({
      claimable: false,
      reason: 'leased',
    });
  });

  it('leaves a running row it cannot date to an operator', () => {
    // No lease, no start time. Guessing here would mean yanking a live build
    // out from under a worker that is quietly finishing it.
    expect(claimVerdict(row({ status: 'running' }), RULES)).toEqual({
      claimable: false,
      reason: 'running-without-lease',
    });
  });

  it('still refuses a finished or cancelled job outright', () => {
    for (const status of ['succeeded', 'canceled']) {
      expect(claimVerdict(row({ status }), RULES)).toEqual({
        claimable: false,
        reason: 'terminal',
      });
    }
  });

  it('honours backoff recorded on the row', () => {
    const backingOff = row({ status: 'failed', run_after: iso(30_000) });
    expect(claimVerdict(backingOff, RULES)).toEqual({
      claimable: false,
      reason: 'not-due',
    });
    expect(claimVerdict({ ...backingOff, run_after: iso(-1) }, RULES)).toEqual({
      claimable: true,
      recovered: false,
    });
  });

  it('stops retrying once the budget on the row is spent', () => {
    expect(
      claimVerdict(row({ status: 'failed', attempt_count: 3 }), RULES),
    ).toEqual({ claimable: false, reason: 'attempts-exhausted' });
    // An operator re-dispatch raises max_attempts on the row, and the row wins.
    expect(
      claimVerdict(
        row({ status: 'failed', attempt_count: 3, max_attempts: 4 }),
        RULES,
      ),
    ).toEqual({ claimable: true, recovered: false });
  });

  it('ignores a kind this worker does not run', () => {
    expect(claimVerdict(row({ kind: 'INLINE_EDIT' }), RULES)).toEqual({
      claimable: false,
      reason: 'wrong-kind',
    });
  });

  it('claims the other two kinds that ride the same endpoint', () => {
    for (const kind of ['SITE_REBUILD', 'CHANGE_REQUEST_BUILD']) {
      expect(claimVerdict(row({ kind }), RULES).claimable).toBe(true);
    }
  });
});

describe('lease arithmetic', () => {
  it('prefers the lease column over the start time', () => {
    expect(
      leaseDeadline(
        row({ started_at: iso(-1_000_000), lease_expires_at: iso(5_000) }),
        TTL,
      ),
    ).toBe(NOW + 5_000);
  });

  it('reads an unparseable timestamp as no lease at all', () => {
    expect(leaseDeadline(row({ lease_expires_at: 'soon' }), TTL)).toBe(null);
    expect(leaseHeld(row({ lease_expires_at: 'soon' }), RULES)).toBe(false);
  });

  it('treats a missing run_after as due now', () => {
    expect(isDue(row(), NOW)).toBe(true);
    expect(isDue(row({ run_after: null }), NOW)).toBe(true);
  });

  it('falls back to the configured budget when the row carries none', () => {
    expect(attemptBudget(row(), 3)).toBe(3);
    expect(attemptBudget(row({ max_attempts: 0 }), 3)).toBe(3);
    expect(attemptBudget(row({ max_attempts: 7 }), 3)).toBe(7);
  });
});

describe('backoff', () => {
  it('doubles per attempt and stops at the cap', () => {
    const rules = { baseMs: 30_000, maxMs: 900_000 };
    expect(backoffMs(1, rules)).toBe(30_000);
    expect(backoffMs(2, rules)).toBe(60_000);
    expect(backoffMs(3, rules)).toBe(120_000);
    expect(backoffMs(20, rules)).toBe(900_000);
  });

  it('never returns less than the base, whatever the attempt number is', () => {
    const rules = { baseMs: 1_000, maxMs: 10_000 };
    expect(backoffMs(0, rules)).toBe(1_000);
    expect(backoffMs(-5, rules)).toBe(1_000);
  });

  it('writes the next attempt as an instant, not a duration', () => {
    expect(nextRunAfter(NOW, 2, { baseMs: 30_000, maxMs: 900_000 })).toBe(
      new Date(NOW + 60_000).toISOString(),
    );
  });
});

describe('publishedResult', () => {
  it('reads back what a finished build published', () => {
    expect(
      publishedResult({
        commitSha: 'abc123',
        pullRequestUrl: 'https://github.com/o/r/pull/1',
        stagingUrl: 'https://x.staging.flowstarter.dev',
        somethingElse: true,
      }),
    ).toEqual({
      commitSha: 'abc123',
      pullRequestUrl: 'https://github.com/o/r/pull/1',
      stagingUrl: 'https://x.staging.flowstarter.dev',
    });
  });

  it('reads a half-written publish as not published', () => {
    expect(publishedResult({ commitSha: 'abc123' })).toBe(null);
    expect(publishedResult({ pullRequestUrl: 'https://x/1' })).toBe(null);
    expect(
      publishedResult({ commitSha: '  ', pullRequestUrl: 'https://x/1' }),
    ).toBe(null);
  });

  it('survives a payload an operator edited into nonsense', () => {
    expect(publishedResult(null)).toBe(null);
    expect(publishedResult('published!')).toBe(null);
    expect(publishedResult([1, 2, 3])).toBe(null);
  });
});

describe('staleLeaseAction', () => {
  const dead = {
    status: 'running',
    leased_by: 'builder-1:9:ff',
    lease_expires_at: iso(-1),
  };

  it('completes a build that crashed after it had already published', () => {
    // The expensive, irreversible half already happened: the commit is pushed
    // and the PR is open. Rebuilding would open a second one.
    const action = staleLeaseAction(
      row({
        ...dead,
        payload: {
          commitSha: 'abc123',
          pullRequestUrl: 'https://github.com/o/r/pull/7',
          stagingUrl: 'https://x.staging.flowstarter.dev',
        },
      }),
      RULES,
    );
    expect(action).toEqual({
      action: 'complete',
      published: {
        commitSha: 'abc123',
        pullRequestUrl: 'https://github.com/o/r/pull/7',
        stagingUrl: 'https://x.staging.flowstarter.dev',
      },
    });
  });

  it('re-queues a build that crashed before it published anything', () => {
    expect(staleLeaseAction(row({ ...dead, attempt_count: 1 }), RULES)).toEqual(
      {
        action: 'requeue',
      },
    );
  });

  it('fails a build with no attempts left rather than looping on it', () => {
    expect(staleLeaseAction(row({ ...dead, attempt_count: 3 }), RULES)).toEqual(
      {
        action: 'abandon',
      },
    );
  });

  it('leaves a live build, a finished one, and a foreign kind alone', () => {
    expect(
      staleLeaseAction(
        row({ status: 'running', lease_expires_at: iso(60_000) }),
        RULES,
      ),
    ).toEqual({ action: 'leave', reason: 'leased' });
    expect(staleLeaseAction(row({ status: 'queued' }), RULES)).toEqual({
      action: 'leave',
      reason: 'not-running',
    });
    expect(
      staleLeaseAction(row({ ...dead, kind: 'INLINE_EDIT' }), RULES),
    ).toEqual({ action: 'leave', reason: 'wrong-kind' });
    expect(staleLeaseAction(row({ status: 'running' }), RULES)).toEqual({
      action: 'leave',
      reason: 'running-without-lease',
    });
  });
});

describe('leaseOwner', () => {
  it('names a process, not a person', () => {
    expect(leaseOwner({ hostname: 'build-1', pid: 42, nonce: 'a1b2' })).toBe(
      'build-1:42:a1b2',
    );
  });

  it('stays inside what the column will hold', () => {
    expect(
      leaseOwner({ hostname: 'h'.repeat(400), pid: 1, nonce: 'ff' }).length,
    ).toBe(200);
  });
});
