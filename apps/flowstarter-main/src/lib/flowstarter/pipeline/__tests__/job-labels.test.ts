/**
 * The labels an operator reads, and the rule that places a job on the board.
 *
 * Two things are worth pinning down here: no enum ever reaches a screen, and
 * the column a job lands in is decided by status first and phase second, so a
 * finished build cannot be dragged back into "Checking" by whatever its last
 * phase happened to say.
 */
import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  BOARD_COLUMNS,
  actorLabel,
  boardColumnFor,
  errorCodeLabel,
  eventKindLabel,
  eventSummary,
  jobKindLabel,
  jobStatusLabel,
  phaseLabel,
  projectStateLabel,
} from '../job-labels';

describe('job kind labels', () => {
  it('names every kind the queue runs', () => {
    expect(jobKindLabel('FULL_SITE_BUILD')).toBe('Full site build');
    expect(jobKindLabel('SITE_REBUILD')).toBe('Publish client edit');
    expect(jobKindLabel('INLINE_EDIT')).toBe('Inline edit');
    expect(jobKindLabel('PREVIEW_GENERATE')).toBe('Preview generation');
    expect(jobKindLabel('ASSET_INGEST')).toBe('Asset ingest');
    expect(jobKindLabel('ASSET_REQUEST')).toBe('Asset request');
    expect(jobKindLabel('REMINDER')).toBe('Reminder');
    expect(jobKindLabel('PREVIEW_REAP')).toBe('Preview cleanup');
  });

  it('reads a kind nobody has named yet as English, not as an enum', () => {
    expect(jobKindLabel('SOMETHING_NEW_ENTIRELY')).toBe(
      'Something new entirely'
    );
    expect(jobKindLabel('reminder')).toBe('Reminder');
    expect(jobKindLabel('')).toBe('Unknown job');
  });
});

describe('job status labels', () => {
  it('says what a status means to a human', () => {
    expect(jobStatusLabel('queued')).toBe('Waiting for a worker');
    expect(jobStatusLabel('running')).toBe('In progress');
    expect(jobStatusLabel('succeeded')).toBe('Finished');
    expect(jobStatusLabel('failed')).toBe('Failed');
    expect(jobStatusLabel('canceled')).toBe('Cancelled');
  });

  it('falls back rather than printing a raw value', () => {
    expect(jobStatusLabel('half_done')).toBe('Half done');
  });
});

describe('phase labels', () => {
  it('leaves the worker phrasing alone, including its suffixes', () => {
    expect(
      phaseLabel('Agents expanding the site, with 2 note(s) from the team')
    ).toBe('Agents expanding the site, with 2 note(s) from the team');
    expect(phaseLabel('Handed to human QA')).toBe('Handed to human QA');
  });
});

describe('project state labels', () => {
  it('names every state the project moves through', () => {
    expect(projectStateLabel(ProjectState.INTAKE)).toBe('Intake');
    expect(projectStateLabel(ProjectState.PREVIEW_READY)).toBe('Preview ready');
    expect(projectStateLabel(ProjectState.DEPOSIT_PAID)).toBe('Deposit paid');
    expect(projectStateLabel(ProjectState.AGENTS_WORKING)).toBe(
      'Agents working'
    );
    expect(projectStateLabel(ProjectState.HUMAN_QA)).toBe('Human QA');
    expect(projectStateLabel(ProjectState.LIVE_SUBSCRIPTION)).toBe(
      'Live subscription'
    );
  });

  it('falls back to sentence case for a state the enum does not know', () => {
    expect(projectStateLabel('SOMETHING_ELSE')).toBe('Something else');
  });
});

describe('error code labels', () => {
  it('turns every code the queue actually writes into a sentence', () => {
    expect(errorCodeLabel('FULL_SITE_BUILD_FAILED')).toBe(
      'The site build failed'
    );
    expect(errorCodeLabel('SITE_REBUILD_FAILED')).toBe(
      'Publishing the client edit failed'
    );
    expect(errorCodeLabel('INVALID_PROJECT_STATE')).toBe(
      'The project was not in a state that allows this build'
    );
    expect(errorCodeLabel('BUILD_JOB_UNCLAIMABLE')).toBe(
      'The job could not be picked up'
    );
    expect(errorCodeLabel('operator_canceled')).toBe(
      'An operator cancelled this job'
    );
  });

  it('title-cases a code nobody has named yet', () => {
    expect(errorCodeLabel('template_missing')).toBe('Template Missing');
    expect(errorCodeLabel('SOME_NEW_CODE')).toBe('Some New Code');
  });
});

describe('event kind labels', () => {
  it('reads the project_events kinds the app actually writes', () => {
    expect(eventKindLabel('state_overridden')).toBe(
      'State moved by an operator'
    );
    expect(eventKindLabel('build_dispatch_failed')).toBe(
      'Build could not be handed to the worker'
    );
    expect(eventKindLabel('build_note_sent')).toBe(
      'Note sent to the build agents'
    );
    expect(eventKindLabel('site_publish_requested')).toBe(
      'Client published an edit'
    );
    expect(eventKindLabel('site_edited')).toBe('Client edited the site');
    expect(eventKindLabel('change_request_quoted')).toBe(
      'Change request quoted'
    );
    expect(eventKindLabel('change_request_paid')).toBe('Change request paid');
    expect(eventKindLabel('change_request_declined')).toBe(
      'Change request declined'
    );
    expect(eventKindLabel('job_canceled')).toBe('Job cancelled by an operator');
  });

  it('title-cases a kind nobody has named yet', () => {
    expect(eventKindLabel('something_brand_new')).toBe('Something Brand New');
  });
});

describe('actor labels', () => {
  it('names the three actors that write events', () => {
    expect(actorLabel('system')).toEqual({ label: 'System', title: null });
    expect(actorLabel('stripe')).toEqual({ label: 'Stripe', title: null });
  });

  it('shows a Clerk id as a team member, with the id in the title', () => {
    const result = actorLabel('user_2abcdEFGH12345xyz');
    expect(result.label).toBe('Team member');
    expect(result.title).toBe('user_2abc…5xyz');
  });

  it('leaves a short id alone rather than truncating it to nothing', () => {
    expect(actorLabel('user_1').title).toBe('user_1');
  });

  it('reads a qualified system writer as System, with the qualifier in the title', () => {
    expect(actorLabel('system:guest_deposit')).toEqual({
      label: 'System',
      title: 'guest_deposit',
    });
  });

  it('falls back to a title-cased word for anything else', () => {
    expect(actorLabel('operator')).toEqual({
      label: 'Operator',
      title: null,
    });
  });
});

describe('event summaries', () => {
  it('summarizes a state change from its payload', () => {
    expect(
      eventSummary('state_overridden', {
        from: ProjectState.DEPOSIT_PAID,
        to: ProjectState.AGENTS_WORKING,
      })
    ).toBe('From Deposit paid to Agents working');
  });

  it('summarizes a note by its length', () => {
    expect(eventSummary('build_note_sent', { chars: 107 })).toBe(
      '107 characters'
    );
    expect(eventSummary('build_note_sent', { chars: 1 })).toBe('1 character');
  });

  it('summarizes a publish with whether a rebuild followed', () => {
    expect(
      eventSummary('site_publish_requested', {
        version: 3,
        rebuildJobId: 'job_1',
      })
    ).toBe('Version 3 published, rebuild queued');
    expect(eventSummary('site_publish_requested', { version: 2 })).toBe(
      'Version 2 published'
    );
  });

  it('summarizes a quote in the request currency', () => {
    expect(
      eventSummary('change_request_quoted', {
        amountMinor: 18_000,
        currency: 'eur',
      })
    ).toBe('Quoted €180.00');
  });

  it('summarizes a free change request without a currency', () => {
    expect(eventSummary('change_request_paid', { amountMinor: 0 })).toBe(
      'Paid, free of charge'
    );
  });

  it('returns null for a kind with no rule, or a payload missing its fields', () => {
    expect(eventSummary('preview_claimed', { previewId: 'p1' })).toBeNull();
    expect(eventSummary('build_note_sent', {})).toBeNull();
    expect(eventSummary('build_note_sent', null)).toBeNull();
  });
});

describe('the board columns', () => {
  it('runs left to right in the order work moves, each with a hint', () => {
    expect(BOARD_COLUMNS.map((c) => c.id)).toEqual([
      'waiting',
      'building',
      'checking',
      'publishing',
      'done',
      'attention',
    ]);
    expect(BOARD_COLUMNS.map((c) => c.title)).toEqual([
      'Waiting',
      'Building',
      'Checking',
      'Publishing',
      'Done',
      'Needs attention',
    ]);
    for (const column of BOARD_COLUMNS) {
      expect(column.hint.length).toBeGreaterThan(10);
    }
  });

  it('has a column for every value boardColumnFor can return', () => {
    const ids = new Set(BOARD_COLUMNS.map((c) => c.id));
    for (const status of [
      'queued',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'nonsense',
    ]) {
      expect(ids.has(boardColumnFor({ status, latestPhase: null }))).toBe(true);
    }
  });
});

describe('placing a job on the board', () => {
  it('parks a queued job in Waiting whatever it once reported', () => {
    expect(
      boardColumnFor({ status: 'queued', latestPhase: 'Checking the build' })
    ).toBe('waiting');
  });

  it('places a running job by what it is doing now', () => {
    const cases: Array<[string, string]> = [
      ['Preparing a clean worktree', 'building'],
      ['Materializing the approved preview', 'building'],
      ['Agents expanding the site, with 3 note(s) from the team', 'building'],
      ['Applying 2 note(s) from the team', 'building'],
      ['Checking the build', 'checking'],
      ['Repairing the build', 'checking'],
      ['Checking the repaired build', 'checking'],
      ['Committing the site', 'publishing'],
      ['Publishing for review', 'publishing'],
      ['Publishing', 'publishing'],
    ];
    for (const [phase, column] of cases) {
      expect(boardColumnFor({ status: 'running', latestPhase: phase })).toBe(
        column
      );
    }
  });

  it('keeps a running job in Building before it reports anything', () => {
    expect(boardColumnFor({ status: 'running', latestPhase: null })).toBe(
      'building'
    );
    expect(boardColumnFor({ status: 'running' })).toBe('building');
    // A late phase the map does not know is still work in flight.
    expect(
      boardColumnFor({ status: 'running', latestPhase: 'Handed to human QA' })
    ).toBe('building');
  });

  it('lets status win over the last phase for a job that has stopped', () => {
    expect(boardColumnFor({ status: 'succeeded', latestPhase: 'Live' })).toBe(
      'done'
    );
    expect(
      boardColumnFor({ status: 'failed', latestPhase: 'Checking the build' })
    ).toBe('attention');
    expect(
      boardColumnFor({ status: 'canceled', latestPhase: 'Agents expanding' })
    ).toBe('attention');
  });

  it('surfaces a status the app does not know instead of hiding it', () => {
    expect(boardColumnFor({ status: 'sleeping', latestPhase: null })).toBe(
      'attention'
    );
  });
});

describe('an event summary a payload cannot support', () => {
  it('says nothing rather than printing undefined', () => {
    // The caller falls back to the kind label; a half-read payload must never
    // reach an operator as "From undefined to undefined".
    expect(eventSummary('state_changed', { to: 'DEPOSIT_PAID' })).toBeNull();
    expect(eventSummary('state_changed', { from: 'INTAKE' })).toBeNull();
    expect(eventSummary('build_note_sent', {})).toBeNull();
    expect(
      eventSummary('build_redispatched', { dispatched: 'yes' })
    ).toBeNull();
    expect(eventSummary('job_canceled', {})).toBeNull();
    expect(eventSummary('build_dispatch_failed', {})).toBeNull();
    expect(eventSummary('site_publish_requested', {})).toBeNull();
    expect(eventSummary('change_request_quoted', {})).toBeNull();
    expect(eventSummary('change_request_paid', {})).toBeNull();
  });

  it('says nothing for a kind that has no rule, or a payload that is not one', () => {
    expect(eventSummary('something_new', { anything: true })).toBeNull();
    expect(eventSummary('state_changed', null)).toBeNull();
    expect(eventSummary('state_changed', 'INTAKE -> DEPOSIT_PAID')).toBeNull();
  });
});

describe('the rest of the event summaries', () => {
  it('tells an operator whether a re-dispatch actually reached the worker', () => {
    expect(eventSummary('build_redispatched', { dispatched: true })).toBe(
      'Re-queued and handed to the worker'
    );
    expect(eventSummary('build_redispatched', { dispatched: false })).toBe(
      'Re-queued, but the worker could not be reached'
    );
  });

  it('names the job that was cancelled', () => {
    expect(eventSummary('job_canceled', { jobKind: 'FULL_SITE_BUILD' })).toBe(
      'Full site build cancelled'
    );
  });

  it('repeats the dispatch failure verbatim, which is what an operator acts on', () => {
    expect(
      eventSummary('build_dispatch_failed', {
        detail: 'Flowstarter build worker is not configured',
      })
    ).toBe('Flowstarter build worker is not configured');
  });

  it('formats a paid change request in its own currency', () => {
    expect(
      eventSummary('change_request_paid', {
        amountMinor: 19_000,
        currency: 'eur',
      })
    ).toBe('Paid €190.00');
    expect(
      eventSummary('change_request_quoted', {
        amountMinor: 24_000,
        currency: 'ron',
      })
    ).toContain('240.00');
    // A quote stored without a currency is euros, like every other amount.
    expect(eventSummary('change_request_quoted', { amountMinor: 9_000 })).toBe(
      'Quoted €90.00'
    );
  });

  it('still shows the amount when the currency code is not one Intl knows', () => {
    expect(
      eventSummary('change_request_paid', {
        amountMinor: 12_345,
        currency: 'not-a-currency',
      })
    ).toBe('Paid 123.45 NOT-A-CURRENCY');
  });
});

describe('a label for a word with no letters in it', () => {
  it('falls back rather than rendering an empty string', () => {
    expect(jobKindLabel('   ')).toBe('Unknown job');
    expect(errorCodeLabel('__')).toBe('Unknown');
  });
});
