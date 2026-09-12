/**
 * What a client is told when their build is not moving.
 *
 * On 2026-09-12 a client whose paid build had failed was shown "Thanks, your
 * deposit is in / Your build is booked and about to start. Nothing is needed
 * from you right now." That sentence was true of `project_state`, which the
 * worker had rolled back to DEPOSIT_PAID so a retry could claim the job, and
 * false of everything else. Alongside it the payments panel read "Paid. Your
 * site is cleared to go live." for a site that was not going anywhere.
 */
import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  clientBuildSignal,
  type ClientBuildJobRow,
} from '../project-build-signal';
import { currentStage, stageCopy } from '../project-progress';
import { paymentPosition, projectPayments } from '../project-payment';

const NOW = new Date('2026-09-12T00:00:00.000Z');
const JOB = '74859ac5-6737-4dde-80ce-d82ef5e76a59';

function job(overrides: Partial<ClientBuildJobRow> = {}): ClientBuildJobRow {
  return {
    id: JOB,
    kind: 'FULL_SITE_BUILD',
    status: 'succeeded',
    created_at: '2026-09-11T21:54:04.357Z',
    run_after: '2026-09-11T21:54:04.357Z',
    started_at: '2026-09-11T21:54:04.443Z',
    finished_at: '2026-09-11T22:09:01.605Z',
    ...overrides,
  };
}

describe('clientBuildSignal', () => {
  it('says nothing about a build that is fine', () => {
    expect(clientBuildSignal([job()], NOW)).toBeNull();
    expect(clientBuildSignal([], NOW)).toBeNull();
  });

  it('reports the failed build the 2026-09-12 run left behind', () => {
    expect(clientBuildSignal([job({ status: 'failed' })], NOW)).toEqual({
      jobId: JOB,
      attention: 'failed',
    });
  });

  it('treats a cancelled build the same, because nobody is building', () => {
    expect(
      clientBuildSignal([job({ status: 'canceled' })], NOW)?.attention
    ).toBe('failed');
  });

  it('reports a queued build nobody picked up', () => {
    expect(
      clientBuildSignal(
        [
          job({
            status: 'queued',
            run_after: '2026-09-11T23:00:00.000Z',
            started_at: null,
            finished_at: null,
          }),
        ],
        NOW
      )?.attention
    ).toBe('stalled');
  });

  it('leaves a queued build inside its dispatch window alone', () => {
    expect(
      clientBuildSignal(
        [
          job({
            status: 'queued',
            run_after: '2026-09-11T23:59:00.000Z',
            started_at: null,
            finished_at: null,
          }),
        ],
        NOW
      )
    ).toBeNull();
  });

  it('reports a build that has been running far too long', () => {
    expect(
      clientBuildSignal(
        [
          job({
            status: 'running',
            started_at: '2026-09-11T12:00:00.000Z',
            finished_at: null,
          }),
        ],
        NOW
      )?.attention
    ).toBe('stalled');
    expect(
      clientBuildSignal(
        [
          job({
            status: 'running',
            started_at: '2026-09-11T23:30:00.000Z',
            finished_at: null,
          }),
        ],
        NOW
      )
    ).toBeNull();
  });

  it('looks at the newest full build and ignores every other job kind', () => {
    expect(
      clientBuildSignal(
        [
          job({ id: 'rebuild', kind: 'SITE_REBUILD', status: 'failed' }),
          job({
            id: 'old',
            status: 'failed',
            created_at: '2026-09-01T00:00:00.000Z',
          }),
          job({ id: 'new', status: 'succeeded' }),
        ],
        NOW
      )
    ).toBeNull();
  });

  /**
   * A build the worker is deliberately holding back.
   *
   * The deposit enqueues the build and the worker will not claim it until the
   * client's in-depth brief is ready, so `queued` for two days is now an
   * ordinary, healthy state that the client's own dashboard used to report as
   * "Your build has not moved for a while". That is an alarm about us for a
   * situation only they can end, and it arrives in the same week we start
   * asking them to fill in a form.
   */
  describe('waiting on the client brief', () => {
    function queuedSince(when: string): ClientBuildJobRow {
      return job({
        status: 'queued',
        run_after: when,
        created_at: when,
        started_at: null,
        finished_at: null,
      });
    }

    it('says we are waiting on them, not that the build is stuck', () => {
      // Queued since yesterday: well past QUEUED_JOB_STALL_MS, and still not a
      // stall, because the reason it has not moved is known and is not ours.
      expect(
        clientBuildSignal([queuedSince('2026-09-10T00:00:00.000Z')], NOW, {
          briefReady: false,
        })
      ).toEqual({ jobId: JOB, attention: 'waiting_on_brief' });
    });

    it('says it from the moment the job is queued, with no waiting period', () => {
      expect(
        clientBuildSignal([queuedSince('2026-09-11T23:59:00.000Z')], NOW, {
          briefReady: false,
        })?.attention
      ).toBe('waiting_on_brief');
    });

    it('still reports a genuine stall once the brief is ready', () => {
      expect(
        clientBuildSignal([queuedSince('2026-09-10T00:00:00.000Z')], NOW, {
          briefReady: true,
        })?.attention
      ).toBe('stalled');
    });

    it('leaves a failed build reading as failed either way', () => {
      // A brief that is not finished does not explain a build that broke, and
      // this one has to keep reaching `notifyClientBuildNeedsReview`.
      expect(
        clientBuildSignal([job({ status: 'failed' })], NOW, {
          briefReady: false,
        })?.attention
      ).toBe('failed');
    });

    it('does not invent a wait for a caller that did not read the brief', () => {
      // `briefReady` undefined means "not looked at". Suppressing a stall on
      // that would hide a real one from every caller that has not been updated.
      expect(
        clientBuildSignal([queuedSince('2026-09-10T00:00:00.000Z')], NOW)
          ?.attention
      ).toBe('stalled');
      expect(
        clientBuildSignal([queuedSince('2026-09-10T00:00:00.000Z')], NOW, {})
          ?.attention
      ).toBe('stalled');
    });

    it('never says it about a build that is already running', () => {
      expect(
        clientBuildSignal(
          [job({ status: 'running', started_at: NOW.toISOString() })],
          NOW,
          { briefReady: false }
        )
      ).toBeNull();
    });
  });

  it('falls back to created_at when a queued row has no run_after', () => {
    expect(
      clientBuildSignal(
        [
          job({
            status: 'queued',
            run_after: null,
            started_at: null,
            finished_at: null,
          }),
        ],
        NOW
      )?.attention
    ).toBe('stalled');
  });
});

describe('stageCopy', () => {
  it('reads as the stage itself when the build is fine', () => {
    const stage = currentStage(ProjectState.DEPOSIT_PAID);
    expect(stageCopy(ProjectState.DEPOSIT_PAID)).toEqual({
      title: stage.title,
      detail: stage.detail,
    });
  });

  it('never says "about to start" to a client whose build stopped', () => {
    const copy = stageCopy(ProjectState.DEPOSIT_PAID, {
      jobId: JOB,
      attention: 'failed',
    });

    expect(copy.title).toBe('Your build needs a second look');
    expect(copy.detail).toContain('a person on our team is checking it now');
    expect(copy.detail).not.toContain('about to start');
  });

  it('says a person is on a stalled build too', () => {
    const copy = stageCopy(ProjectState.AGENTS_WORKING, {
      jobId: JOB,
      attention: 'stalled',
    });

    expect(copy.title).toBe('Your build has not moved for a while');
    expect(copy.detail).toContain('a person on our team is looking at it');
  });

  it('asks for the brief instead of promising nothing is needed', () => {
    const stage = currentStage(ProjectState.DEPOSIT_PAID);
    const copy = stageCopy(ProjectState.DEPOSIT_PAID, {
      jobId: JOB,
      attention: 'waiting_on_brief',
    });

    // The stage copy this replaces is the exact sentence that would be false.
    expect(stage.detail).toContain('Nothing is needed from you');
    expect(copy.title).toBe('We are waiting on your brief');
    expect(copy.detail).toContain('Your brief');
    expect(copy.detail).not.toContain('Nothing is needed from you');
    // And it is not the stall copy, which says a person is looking into it.
    expect(copy.detail).not.toContain('a person on our team');
  });
});

describe('paymentPosition and a stopped build', () => {
  const paidInFull = {
    project_state: ProjectState.DEPOSIT_PAID,
    deposit_status: 'paid',
    final_status: 'paid',
    final_value_minor: 79900,
    billing_currency: 'eur',
  };

  it('does not promise a site is cleared to go live when it is not', () => {
    const payments = projectPayments(paidInFull, 'ws');
    const lines = paymentPosition(payments, {
      jobId: JOB,
      attention: 'failed',
    });
    const balance = lines.find((line) => line.key === 'balance');

    expect(balance?.status).toBe('paid');
    expect(balance?.note).not.toContain('cleared to go live');
    expect(balance?.note).toContain('needs a second look');
  });

  it('keeps the ordinary copy when nothing is wrong', () => {
    const lines = paymentPosition(projectPayments(paidInFull, 'ws'));
    expect(lines.find((line) => line.key === 'balance')?.note).toBe(
      'Paid. Your site is cleared to go live.'
    );
  });

  it('does not tell a client waiting on their own brief that the build needs a second look', () => {
    const lines = paymentPosition(projectPayments(paidInFull, 'ws'), {
      jobId: JOB,
      attention: 'waiting_on_brief',
    });
    expect(lines.find((line) => line.key === 'balance')?.note).toBe(
      'Paid. Your site is cleared to go live.'
    );
  });

  it('does not tell an unpaid client the balance is simply coming', () => {
    const lines = paymentPosition(
      projectPayments({ ...paidInFull, final_status: 'pending' }, 'ws'),
      { jobId: JOB, attention: 'failed' }
    );
    const balance = lines.find((line) => line.key === 'balance');

    expect(balance?.status).toBe('upcoming');
    expect(balance?.note).toContain('needs a second look');
  });

  it('leaves the balance gate exactly where the server has it', () => {
    // HUMAN_QA and nothing else. A stopped build does not open it, and this
    // is the half of the panel that must not move.
    expect(
      projectPayments({ ...paidInFull, final_status: 'pending' }, 'ws').due
    ).toBeNull();
    expect(
      projectPayments(
        {
          ...paidInFull,
          project_state: ProjectState.HUMAN_QA,
          final_status: 'pending',
        },
        'ws'
      ).due?.kind
    ).toBe('balance');
  });
});
