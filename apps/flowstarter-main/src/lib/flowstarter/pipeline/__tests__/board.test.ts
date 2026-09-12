/**
 * The board's job is to make a stuck project obvious. These cases pin the two
 * ways a project gets stuck — a job nobody is running, and a state nobody is
 * moving — and the grouping that puts them in front of an operator.
 */
import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  QUEUED_JOB_STALL_MS,
  RUNNING_JOB_STALL_MS,
  STATE_STALL_MS,
  buildPipelineBoard,
  formatDuration,
  latestJobByWorkspace,
  stallReasonsFor,
  stateChangedAtByWorkspace,
  summarizeJob,
  toPipelineCard,
  type PipelineEventRow,
  type PipelineJobRow,
  type PipelineWorkspaceRow,
} from '../board';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function workspace(
  overrides: Partial<PipelineWorkspaceRow> & { id: string }
): PipelineWorkspaceRow {
  return {
    name: 'Project',
    slug: 'project',
    client_business_name: 'Acme Ltd',
    client_name: null,
    client_email: 'owner@acme.test',
    project_state: ProjectState.INTAKE,
    deposit_status: 'none',
    deposit_paid_at: null,
    final_value_minor: 199_900,
    setup_fee: null,
    billing_currency: 'eur',
    created_at: ago(60_000),
    updated_at: ago(60_000),
    ...overrides,
  };
}

function job(
  overrides: Partial<PipelineJobRow> & { id: string; workspace_id: string }
): PipelineJobRow {
  return {
    kind: 'FULL_SITE_BUILD',
    status: 'queued',
    attempt_count: 0,
    max_attempts: 3,
    run_after: ago(60_000),
    created_at: ago(60_000),
    started_at: null,
    finished_at: null,
    error_code: null,
    error_detail: null,
    ...overrides,
  };
}

describe('buildPipelineBoard grouping', () => {
  it('puts every project in its own state column and keeps empty columns', () => {
    const board = buildPipelineBoard({
      workspaces: [
        workspace({ id: 'a', project_state: ProjectState.INTAKE }),
        workspace({ id: 'b', project_state: ProjectState.PREVIEW_READY }),
        workspace({ id: 'c', project_state: ProjectState.PREVIEW_READY }),
        workspace({ id: 'd', project_state: ProjectState.LIVE_SUBSCRIPTION }),
      ],
      jobs: [],
      events: [],
      now: NOW,
    });

    expect(board.columns.map((c) => c.state)).toEqual([
      ProjectState.INTAKE,
      ProjectState.PREVIEW_READY,
      ProjectState.DEPOSIT_PAID,
      ProjectState.AGENTS_WORKING,
      ProjectState.HUMAN_QA,
      ProjectState.LIVE_SUBSCRIPTION,
    ]);

    const byState = Object.fromEntries(
      board.columns.map((c) => [
        c.state,
        c.cards.map((card) => card.workspaceId),
      ])
    );
    expect(byState[ProjectState.INTAKE]).toEqual(['a']);
    expect(byState[ProjectState.PREVIEW_READY]).toHaveLength(2);
    expect(byState[ProjectState.DEPOSIT_PAID]).toEqual([]);
    expect(byState[ProjectState.LIVE_SUBSCRIPTION]).toEqual(['d']);
    expect(board.total).toBe(4);
  });

  it('orders each column newest first', () => {
    const board = buildPipelineBoard({
      workspaces: [
        workspace({ id: 'old', created_at: ago(5 * 60_000) }),
        workspace({ id: 'new', created_at: ago(60_000) }),
        workspace({ id: 'middle', created_at: ago(3 * 60_000) }),
      ],
      jobs: [],
      events: [],
      now: NOW,
    });

    const intake = board.columns.find((c) => c.state === ProjectState.INTAKE);
    expect(intake?.cards.map((c) => c.workspaceId)).toEqual([
      'new',
      'middle',
      'old',
    ]);
  });

  it('omits a row whose project_state the enum does not know', () => {
    const board = buildPipelineBoard({
      workspaces: [
        workspace({ id: 'known' }),
        workspace({ id: 'drifted', project_state: 'SOMETHING_ELSE' }),
      ],
      jobs: [],
      events: [],
      now: NOW,
    });
    expect(board.total).toBe(1);
    expect(
      board.columns.flatMap((c) => c.cards.map((card) => card.workspaceId))
    ).toEqual(['known']);
  });

  it('prices from the shared quote source, including legacy setup_fee rows', () => {
    const board = buildPipelineBoard({
      workspaces: [
        workspace({ id: 'minor', final_value_minor: 250_000, setup_fee: 1 }),
        workspace({ id: 'legacy', final_value_minor: null, setup_fee: 1499.5 }),
      ],
      jobs: [],
      events: [],
      now: NOW,
    });
    const cards = board.columns.flatMap((c) => c.cards);
    expect(cards.find((c) => c.workspaceId === 'minor')?.quoteMinor).toBe(
      250_000
    );
    expect(cards.find((c) => c.workspaceId === 'legacy')?.quoteMinor).toBe(
      149_950
    );
  });
});

describe('stall detection', () => {
  it('flags a queued job that nobody picked up', () => {
    const reasons = stallReasonsFor({
      state: ProjectState.DEPOSIT_PAID,
      timeInStateMs: 60_000,
      job: job({
        id: 'j',
        workspace_id: 'w',
        status: 'queued',
        run_after: ago(QUEUED_JOB_STALL_MS + 60_000),
        created_at: ago(QUEUED_JOB_STALL_MS + 60_000),
      }),
      now: NOW,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/queued/);
  });

  it('does not flag a queued job still inside its backoff window', () => {
    const reasons = stallReasonsFor({
      state: ProjectState.DEPOSIT_PAID,
      timeInStateMs: 60_000,
      job: job({
        id: 'j',
        workspace_id: 'w',
        status: 'queued',
        created_at: ago(6 * 60 * 60_000),
        // Backoff pushes it into the future — waiting is expected, not stuck.
        run_after: new Date(NOW + 60_000).toISOString(),
      }),
      now: NOW,
    });
    expect(reasons).toEqual([]);
  });

  it('flags a build that has been running far too long, and a failed one', () => {
    expect(
      stallReasonsFor({
        state: ProjectState.AGENTS_WORKING,
        timeInStateMs: 60_000,
        job: job({
          id: 'j',
          workspace_id: 'w',
          status: 'running',
          started_at: ago(RUNNING_JOB_STALL_MS + 60_000),
        }),
        now: NOW,
      })
    ).toHaveLength(1);

    expect(
      stallReasonsFor({
        state: ProjectState.AGENTS_WORKING,
        timeInStateMs: 60_000,
        job: job({
          id: 'j',
          workspace_id: 'w',
          status: 'failed',
          error_code: 'template_missing',
          attempt_count: 3,
        }),
        now: NOW,
      })[0]
    ).toMatch(/failed \(Template Missing\)/);
  });

  it('flags a project parked in one state past its budget', () => {
    const budget = STATE_STALL_MS[ProjectState.DEPOSIT_PAID] as number;
    expect(
      stallReasonsFor({
        state: ProjectState.DEPOSIT_PAID,
        timeInStateMs: budget + 60_000,
        job: null,
        now: NOW,
      })[0]
    ).toMatch(/In Deposit paid/);
  });

  it('never flags a live project for sitting still', () => {
    expect(
      stallReasonsFor({
        state: ProjectState.LIVE_SUBSCRIPTION,
        timeInStateMs: 365 * 24 * 60 * 60_000,
        job: null,
        now: NOW,
      })
    ).toEqual([]);
  });

  it('counts stalled cards per column and across the board', () => {
    const board = buildPipelineBoard({
      workspaces: [
        workspace({ id: 'healthy', project_state: ProjectState.DEPOSIT_PAID }),
        workspace({ id: 'stuck', project_state: ProjectState.DEPOSIT_PAID }),
      ],
      jobs: [
        job({ id: 'j1', workspace_id: 'healthy' }),
        job({
          id: 'j2',
          workspace_id: 'stuck',
          run_after: ago(QUEUED_JOB_STALL_MS + 60_000),
          created_at: ago(QUEUED_JOB_STALL_MS + 60_000),
        }),
      ],
      events: [],
      now: NOW,
    });

    const column = board.columns.find(
      (c) => c.state === ProjectState.DEPOSIT_PAID
    );
    expect(column?.stalledCount).toBe(1);
    expect(board.stalledCount).toBe(1);
    expect(column?.cards.find((c) => c.workspaceId === 'stuck')?.stalled).toBe(
      true
    );
  });
});

describe('row reducers', () => {
  it('takes the newest job per workspace', () => {
    const latest = latestJobByWorkspace([
      job({ id: 'older', workspace_id: 'w', created_at: ago(10 * 60_000) }),
      job({ id: 'newer', workspace_id: 'w', created_at: ago(60_000) }),
      job({ id: 'other', workspace_id: 'x' }),
    ]);
    expect(latest.get('w')?.id).toBe('newer');
    expect(latest.get('x')?.id).toBe('other');
  });

  it('dates time-in-state from the newest state-change event only', () => {
    const events: PipelineEventRow[] = [
      {
        id: '1',
        workspace_id: 'w',
        kind: 'state_overridden',
        actor: 'user_1',
        payload: {},
        created_at: ago(2 * 60 * 60_000),
      },
      {
        id: '2',
        workspace_id: 'w',
        // Not a state change — must not reset the clock.
        kind: 'build_redispatched',
        actor: 'user_1',
        payload: {},
        created_at: ago(60_000),
      },
    ];
    expect(stateChangedAtByWorkspace(events).get('w')).toBe(
      ago(2 * 60 * 60_000)
    );
  });

  it('falls back to updated_at when nothing has written a state event', () => {
    const board = buildPipelineBoard({
      workspaces: [workspace({ id: 'w', updated_at: ago(90 * 60_000) })],
      jobs: [],
      events: [],
      now: NOW,
    });
    expect(board.columns[0].cards[0].timeInStateMs).toBe(90 * 60_000);
  });
});

/**
 * A build parked on its client's brief.
 *
 * Before it had a status of its own it sat at `queued` and aged past
 * `QUEUED_JOB_STALL_MS`, at which point the board told an operator that
 * dispatch to the worker had probably been dropped. It had not: the deposit
 * was settled, the job existed, and the one thing it needed was a form only
 * the client can fill in. An alarm about our own system for a situation only
 * the client can end is worse than no signal, because it teaches an operator
 * to ignore the board.
 */
describe('waiting on the client brief', () => {
  const parked = () =>
    job({
      id: 'j',
      workspace_id: 'w',
      status: 'waiting_brief',
      // Long past every threshold. There is no number of hours after which
      // waiting for a client becomes a stall.
      created_at: ago(20 * 24 * 60 * 60_000),
      run_after: ago(20 * 24 * 60 * 60_000),
    });

  it('is never a stall, however long it has been waiting', () => {
    expect(
      stallReasonsFor({
        state: ProjectState.DEPOSIT_PAID,
        timeInStateMs: 60_000,
        job: parked(),
        now: NOW,
      })
    ).toEqual([]);
  });

  it('is visible on the card, with the sentence an operator would say', () => {
    const card = toPipelineCard({
      workspace: workspace({ id: 'w' }),
      job: parked(),
      stateSince: ago(60_000),
      now: NOW,
    });
    expect(card.stalled).toBe(false);
    expect(card.waitingOn).toBe('brief');
    expect(card.waitingReason).toContain('brief');
    expect(card.waitingReason).toContain('starts by itself');
  });

  it('says nothing about a brief on a project that is not waiting for one', () => {
    const card = toPipelineCard({
      workspace: workspace({ id: 'w' }),
      job: job({ id: 'j', workspace_id: 'w', status: 'running' }),
      stateSince: ago(60_000),
      now: NOW,
    });
    expect(card.waitingOn).toBeNull();
    expect(card.waitingReason).toBeNull();
  });

  it('still reports the project-state budget, which is about us and not the client', () => {
    // A deposit that has been in DEPOSIT_PAID for days is worth an operator's
    // attention even while the brief is outstanding -- that is the moment to
    // pick up the phone, or to override.
    const reasons = stallReasonsFor({
      state: ProjectState.DEPOSIT_PAID,
      timeInStateMs: 20 * 24 * 60 * 60_000,
      job: parked(),
      now: NOW,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/Deposit/i);
  });
});

describe('the card an operator actually reads', () => {
  it('names a project whose fields were never filled in', () => {
    const card = toPipelineCard({
      workspace: workspace({
        id: 'ws-blank',
        name: null,
        client_business_name: null,
        client_name: null,
      }),
      job: null,
      stateSince: ago(60_000),
      now: NOW,
    });

    expect(card.name).toBe('Untitled project');
    expect(card.businessName).toBe('Unassigned');
  });

  it('prefers the client name over the project name when there is no business', () => {
    const card = toPipelineCard({
      workspace: workspace({
        id: 'ws-1',
        client_business_name: null,
        client_name: 'Maria Ionescu',
      }),
      job: null,
      stateSince: ago(60_000),
      now: NOW,
    });
    expect(card.businessName).toBe('Maria Ionescu');

    expect(
      toPipelineCard({
        workspace: workspace({
          id: 'ws-1',
          client_business_name: null,
          client_name: null,
          name: 'Acme rebuild',
        }),
        job: null,
        stateSince: ago(60_000),
        now: NOW,
      }).businessName
    ).toBe('Acme rebuild');
  });

  it('shows a row whose project_state the enum does not know as intake', () => {
    // buildPipelineBoard drops the row loudly; a card built directly still
    // has to render rather than throw at the operator.
    const card = toPipelineCard({
      workspace: workspace({ id: 'ws-1', project_state: 'ARCHIVED' }),
      job: null,
      stateSince: ago(60_000),
      now: NOW,
    });
    expect(card.projectState).toBe(ProjectState.INTAKE);
  });

  it('ages a job from whenever it last changed hands', () => {
    const created = summarizeJob(
      job({ id: 'j', workspace_id: 'ws-1', created_at: ago(5 * 60_000) }),
      NOW
    );
    expect(created.ageMs).toBe(5 * 60_000);

    const started = summarizeJob(
      job({
        id: 'j',
        workspace_id: 'ws-1',
        created_at: ago(5 * 60_000),
        started_at: ago(2 * 60_000),
      }),
      NOW
    );
    expect(started.ageMs).toBe(2 * 60_000);

    const finished = summarizeJob(
      job({
        id: 'j',
        workspace_id: 'ws-1',
        created_at: ago(5 * 60_000),
        started_at: ago(2 * 60_000),
        finished_at: ago(60_000),
      }),
      NOW
    );
    expect(finished.ageMs).toBe(60_000);
  });
});

describe('reading the freshest row out of a batch', () => {
  it('keeps the newest state change and ignores an older one', () => {
    const events: PipelineEventRow[] = [
      {
        id: 'e2',
        workspace_id: 'ws-1',
        kind: 'state_changed',
        actor: 'system',
        payload: null,
        created_at: ago(60_000),
      },
      {
        id: 'e1',
        workspace_id: 'ws-1',
        kind: 'state_changed',
        actor: 'system',
        payload: null,
        created_at: ago(10 * 60_000),
      },
      // Not a state change: it must not move the clock on the column.
      {
        id: 'e0',
        workspace_id: 'ws-1',
        kind: 'build_note_sent',
        actor: 'system',
        payload: null,
        created_at: ago(1_000),
      },
    ];

    expect(stateChangedAtByWorkspace(events).get('ws-1')).toBe(ago(60_000));
  });

  it('keeps the newest job and ignores an older one', () => {
    const latest = latestJobByWorkspace([
      job({ id: 'new', workspace_id: 'ws-1', created_at: ago(60_000) }),
      job({ id: 'old', workspace_id: 'ws-1', created_at: ago(10 * 60_000) }),
    ]);
    expect(latest.get('ws-1')?.id).toBe('new');
  });
});

describe('how long a duration reads', () => {
  it('rounds down to the unit an operator would use', () => {
    expect(formatDuration(30_000)).toBe('less than a minute');
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(3 * 60 * 60_000)).toBe('3h');
    expect(formatDuration(5 * 24 * 60 * 60_000)).toBe('5d');
  });
});

describe('when nothing recorded a state change', () => {
  it('measures from the row own last touch', () => {
    const board = buildPipelineBoard({
      workspaces: [
        workspace({
          id: 'ws-1',
          project_state: ProjectState.DEPOSIT_PAID,
          updated_at: ago(6 * 60 * 60_000),
          created_at: ago(48 * 60 * 60_000),
        }),
      ],
      jobs: [],
      events: [],
      now: NOW,
    });

    const card = board.columns.find(
      (c) => c.state === ProjectState.DEPOSIT_PAID
    )!.cards[0]!;
    expect(card.stateSince).toBe(ago(6 * 60 * 60_000));
    // Six hours in DEPOSIT_PAID is past the four-hour budget.
    expect(card.stalled).toBe(true);
  });
});
