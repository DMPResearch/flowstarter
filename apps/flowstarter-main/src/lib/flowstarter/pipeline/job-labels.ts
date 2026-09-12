/**
 * Operator-facing words for the job ledger.
 *
 * The database speaks in enums (FULL_SITE_BUILD, `canceled`) because that is
 * what the worker and the unique indexes are keyed on. An operator should
 * never have to read them: every screen that shows a job goes through here,
 * and nothing here ever touches a payload or a stored value.
 *
 * The board column a job belongs in is a rule, not a guess. The worker emits
 * its phases as plain sentences and those sentences are the input, so the
 * mapping lives next to the labels rather than inside a component.
 */
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';

/** Kinds the queue actually runs today. Anything else falls back to sentence case. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  FULL_SITE_BUILD: 'Full site build',
  SITE_REBUILD: 'Publish client edit',
  CHANGE_REQUEST_BUILD: 'Paid change request',
  INLINE_EDIT: 'Inline edit',
  PREVIEW_GENERATE: 'Preview generation',
  ASSET_INGEST: 'Asset ingest',
  ASSET_REQUEST: 'Asset request',
  REMINDER: 'Reminder',
  PREVIEW_REAP: 'Preview cleanup',
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: 'Waiting for a worker',
  running: 'In progress',
  succeeded: 'Finished',
  failed: 'Failed',
  // The column is spelled the American way; the operator reading it is not.
  canceled: 'Cancelled',
};

/**
 * A kind nobody has named yet still has to read as English, so the enum is
 * broken into words and given one capital — the same shape as the labels
 * above, which is what makes a new kind look like it belongs rather than like
 * a bug.
 */
function sentenceCase(kind: string): string {
  const words = kind
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return 'Unknown job';
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * Same idea as `sentenceCase`, but every word gets a capital. Error codes and
 * event kinds read as short labels rather than sentences ("Build Job
 * Unclaimable"), so an unrecognised one should look like a label too.
 */
function titleCase(input: string): string {
  const words = input
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return 'Unknown';
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function jobKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? sentenceCase(kind);
}

export function jobStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? sentenceCase(status);
}

/**
 * The single hook for phase phrasing. The worker already writes its phases as
 * plain sentences ("Materializing the approved preview"), so this returns them
 * untouched; it exists so that a phase which ever needs rewording is reworded
 * in one place instead of in every component that prints one.
 */
export function phaseLabel(phase: string): string {
  return phase;
}

/** Every lifecycle state a project moves through, in plain words. */
const PROJECT_STATE_LABELS: Readonly<Record<string, string>> = {
  [ProjectState.INTAKE]: 'Intake',
  [ProjectState.PREVIEW_READY]: 'Preview ready',
  [ProjectState.DEPOSIT_PAID]: 'Deposit paid',
  [ProjectState.AGENTS_WORKING]: 'Agents working',
  [ProjectState.HUMAN_QA]: 'Human QA',
  [ProjectState.LIVE_SUBSCRIPTION]: 'Live subscription',
};

/**
 * The single source for how a project's lifecycle state reads on screen.
 * Shared by the project header, the state-move dropdown, the stall reasons
 * on the pipeline board, and the timeline, so a state can never say one thing
 * in one place and something else in another.
 */
export function projectStateLabel(state: string): string {
  return PROJECT_STATE_LABELS[state] ?? sentenceCase(state);
}

/**
 * Codes the job ledger writes to `error_code`. An operator reads these next
 * to a card or in the build panel, never in a log — so each one is a full
 * sentence, not a fragment that needs the code alongside it to make sense.
 */
const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  FULL_SITE_BUILD_FAILED: 'The site build failed',
  APPROVED_EDIT_DROPPED: 'The build dropped a change the client approved',
  SITE_REBUILD_FAILED: 'Publishing the client edit failed',
  INVALID_PROJECT_STATE:
    'The project was not in a state that allows this build',
  BUILD_JOB_UNCLAIMABLE: 'The job could not be picked up',
  operator_canceled: 'An operator cancelled this job',
};

/** A code nobody has named yet still reads as words instead of an enum. */
export function errorCodeLabel(code: string): string {
  return ERROR_CODE_LABELS[code] ?? titleCase(code);
}

export type BoardColumnId =
  | 'waiting'
  | 'building'
  | 'checking'
  | 'publishing'
  | 'done'
  | 'attention';

export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  /** One line, shown when the column is empty, so an empty column still teaches. */
  hint: string;
}

/** Left to right, the order work moves through. */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  {
    id: 'waiting',
    title: 'Waiting',
    hint: 'Queued jobs no worker has picked up yet.',
  },
  {
    id: 'building',
    title: 'Building',
    hint: 'The agents are writing the site.',
  },
  {
    id: 'checking',
    title: 'Checking',
    hint: 'The build is being compiled, and repaired if it broke.',
  },
  {
    id: 'publishing',
    title: 'Publishing',
    hint: 'Committing and pushing the finished site out.',
  },
  { id: 'done', title: 'Done', hint: 'Finished builds. Nothing to do here.' },
  {
    id: 'attention',
    title: 'Needs attention',
    hint: 'Failed or cancelled jobs waiting on a human decision.',
  },
];

/**
 * The first word of a phase is what places it, so the mapping survives the
 * worker appending detail to a phase (", with 2 note(s) from the team").
 */
const PHASE_COLUMN: Readonly<Record<string, BoardColumnId>> = {
  preparing: 'building',
  materializing: 'building',
  agents: 'building',
  applying: 'building',
  checking: 'checking',
  repairing: 'checking',
  committing: 'publishing',
  publishing: 'publishing',
};

/**
 * What colours a kanban column, on either board.
 *
 * A board is a sequence, so most columns are not a category at all: they are a
 * position in one. Those take a step of the accent hue — `--fs-stage-1` to
 * `--fs-stage-4` in brand.css — and step 1 is always the board's first
 * progress column, the deepest step always its last, so the ladder runs light
 * to dark left to right.
 *
 * Only three things on a board are genuinely a different kind of state, and
 * they are the only three that get a second hue:
 *   `warn`   a column that will not move without an operator
 *   `ok`     the finished one
 *   `danger` a broken one
 */
export type StageStep = 'stage-1' | 'stage-2' | 'stage-3' | 'stage-4';
export type ColumnTone = StageStep | 'warn' | 'ok' | 'danger';

const STAGE_STEPS: readonly StageStep[] = [
  'stage-1',
  'stage-2',
  'stage-3',
  'stage-4',
];

/** True for the four accent steps, false for the three semantic exceptions. */
export function isStageStep(tone: ColumnTone): tone is StageStep {
  return (STAGE_STEPS as readonly string[]).includes(tone);
}

/**
 * The build board's columns in colour, left to right in the order work
 * actually moves. Companion to `PROJECT_STATE_TONE` in `dashboard.constants.ts`
 * — that table colours the cross-project pipeline board's `ProjectState`
 * columns, this one colours a single project's build-job columns, which are
 * not project states and so need their own table.
 *
 * Three of these six columns are progress and nothing else — a job waits, then
 * gets built, then gets published — so they take the first three steps of the
 * one accent ladder in that order. The other three are the exceptions:
 * `checking`, where a build is compiled and repaired, does not move without an
 * operator, so it is `warn`; `done` is `ok`; `attention`, holding failed and
 * cancelled jobs, is `danger`, the tone the rest of the system reserves for a
 * real failure.
 *
 * The old table gave all six a hue of their own (neutral, accent, warn, info,
 * ok, danger) and the board read as a colour chart rather than as a pipeline.
 */
export const BOARD_COLUMN_TONE: Readonly<Record<BoardColumnId, ColumnTone>> = {
  waiting: 'stage-1',
  building: 'stage-2',
  checking: 'warn',
  publishing: 'stage-3',
  done: 'ok',
  attention: 'danger',
};

export function columnTone(id: BoardColumnId): ColumnTone {
  return BOARD_COLUMN_TONE[id];
}

/** What `columnToneStyle` hands back: every inline style a kanban column on
 * the pipeline or the build board paints with. */
export interface ColumnToneStyle {
  /** The 2px rule along the top of the column panel. */
  rule: { background: string };
  /** The column body. Neutral panel fill unless the column is flagged. */
  wash: { background: string };
  /** The header label. */
  ink: { color: string };
  /** The count pill: fill, ink and rim, in one object. */
  chip: { background: string; color: string; boxShadow: string };
}

/**
 * The one recipe every kanban-shaped column shares, on both boards.
 *
 * The progression is carried by the top rule and the header ink stepping
 * through the accent ladder, and by nothing else. The body is left as the
 * panel's own fill: four columns washed in four alphas of the same hue would
 * be four tints of one colour that say nothing the rules above them have not
 * already said, and a board of tinted rectangles is the colour chart this
 * table exists to stop being.
 *
 * The count pill follows the header rather than carrying its own colour: one
 * accent whisper and one accent rim for every stage column, with only the ink
 * stepping, so a row of six pills reads as one shape at six weights.
 *
 * `emphasis` is the one thing that fills a body, and it fills it with
 * `danger` whatever the column's own colour is, because it means exactly one
 * thing: every card in this column is broken. Only the build board's
 * `attention` column, which holds nothing but failed and cancelled jobs,
 * wears it. The column keeps its own rule and ink underneath.
 *
 * The cross-project pipeline board used to pass it while a column held a
 * stalled card, and that was wrong twice over: the wash is a top-down
 * gradient and stalled cards sort to the top, so what it actually tinted was
 * the stalled card itself, which read as a pink card rather than as a warned
 * column; and a column holding one stuck project out of five is not a broken
 * column. The stall says so on its own card and in the header count instead.
 */
export function columnToneStyle(
  tone: ColumnTone,
  emphasis = false
): ColumnToneStyle {
  const ink = isStageStep(tone)
    ? `var(--fs-${tone})`
    : `var(--fs-tone-${tone})`;
  const rule = isStageStep(tone)
    ? `var(--fs-${tone}-rim)`
    : `var(--fs-tone-${tone})`;
  // A stage column's pill is the accent's own whisper; a semantic one wears
  // its own, so `warn`, `ok` and `danger` still read at a glance.
  const chipTone = isStageStep(tone) ? 'accent' : tone;

  return {
    rule: { background: rule },
    wash: {
      background: emphasis
        ? 'linear-gradient(to bottom, var(--fs-tone-danger-emphasis), transparent)'
        : 'transparent',
    },
    ink: { color: ink },
    chip: {
      background: `var(--fs-tone-${chipTone}-soft)`,
      color: ink,
      boxShadow: `inset 0 0 0 1px var(--fs-tone-${chipTone}-edge)`,
    },
  };
}

/**
 * Where a job sits on the build board.
 *
 * Status decides first — a finished job is done wherever its last phase left
 * it — and only a running job is placed by what it is doing. A running job
 * whose phase is unrecognised (or which has not reported one yet) is still
 * building; that is the honest default for work in flight.
 */
export function boardColumnFor(job: {
  status: string;
  latestPhase?: string | null;
}): BoardColumnId {
  if (job.status === 'failed' || job.status === 'canceled') return 'attention';
  if (job.status === 'succeeded') return 'done';
  // A build parked on its client's brief belongs beside the queued ones: it is
  // waiting, it is not in trouble, and putting it in `attention` (which is
  // where an unrecognised status goes) would make every unfinished brief look
  // like a broken build.
  if (job.status === 'queued' || job.status === 'waiting_brief')
    return 'waiting';
  if (job.status !== 'running') {
    // A status this app does not know is schema drift, and the operator is the
    // one who should find out about it.
    return 'attention';
  }
  const firstWord = (job.latestPhase ?? '').trim().split(/\s+/)[0];
  return PHASE_COLUMN[firstWord.toLowerCase()] ?? 'building';
}

/**
 * `project_events.kind` values actually written by the app today (grepped for
 * `kind: '` under recordEvent / project_events inserts). The timeline is the
 * append-only audit trail, so a kind this map does not know still has to read
 * as words, not silently disappear.
 */
const EVENT_KIND_LABELS: Readonly<Record<string, string>> = {
  state_changed: 'State moved by an operator',
  state_advanced: 'State moved by an operator',
  state_overridden: 'State moved by an operator',
  routing_overridden: 'Intake routing overridden by an operator',
  build_dispatch_failed: 'Build could not be handed to the worker',
  build_redispatched: 'Build re-queued by an operator',
  build_note_sent: 'Note sent to the build agents',
  job_canceled: 'Job cancelled by an operator',
  site_publish_requested: 'Client published an edit',
  site_edited: 'Client edited the site',
  site_edit_proposed: 'Client asked the assistant for an edit',
  site_image_replaced: 'Client replaced an image',
  site_reverted: 'Client reverted to an earlier version',
  change_request_quoted: 'Change request quoted',
  change_request_paid: 'Change request paid',
  change_request_build_queued: 'Change request handed to the build agents',
  change_request_declined: 'Change request declined',
  change_request_done: 'Change request marked done',
  booking_cal_updated: 'Booking link updated',
  booking_cal_connected: 'Cal.com calendar connected',
  booking_cal_disconnected: 'Cal.com calendar disconnected',
  preview_claimed: 'Preview claimed',
  preview_claim_membership_failed:
    'Client could not be given access after claiming',
  project_message_sent: 'Message sent to the client',
  client_reply_recorded: 'Client replied',
  guest_account_provisioned: 'Guest account created for the client',
  guest_credentials_email_failed: 'Welcome email could not be sent',
};

/** A kind nobody has named yet still reads as words instead of an enum. */
export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABELS[kind] ?? titleCase(kind);
}

export interface EventActor {
  /** What the timeline prints. */
  label: string;
  /** The full actor id, shown on hover only, or null when there is none to show. */
  title: string | null;
}

/** Enough of an id to recognise it without printing the whole Clerk id inline. */
function shortenActorId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 9)}…${id.slice(-4)}`;
}

/**
 * Who did this, in three words an operator already knows: the system acting
 * on its own, Stripe's webhook, or a team member. Clerk ids are the only
 * actor shape left once those are ruled out, and the raw id is still one
 * hover away in the title attribute for anyone who needs to look a person up.
 *
 * A few system writers qualify themselves (`system:guest_deposit`) rather
 * than writing the bare 'system' — that qualifier is still "the system", just
 * with which part of it in the title instead of on the label.
 */
export function actorLabel(actor: string): EventActor {
  if (actor === 'system') return { label: 'System', title: null };
  if (actor.startsWith('system:')) {
    return { label: 'System', title: actor.slice('system:'.length) };
  }
  if (actor === 'stripe') return { label: 'Stripe', title: null };
  if (actor.startsWith('user_')) {
    return { label: 'Team member', title: shortenActorId(actor) };
  }
  return { label: titleCase(actor), title: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Minor-unit money, tolerant of a currency code `Intl` does not recognise. */
function formatMinorAmount(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * One deterministic line of what actually happened, read from an event's
 * payload by a fixed rule per kind — never a model, never a guess. A kind
 * with no rule, or a payload missing the fields its rule needs, returns
 * null so the caller falls back to the kind label alone rather than
 * printing "undefined".
 */
export function eventSummary(kind: string, payload: unknown): string | null {
  const p = isRecord(payload) ? payload : {};

  switch (kind) {
    case 'state_changed':
    case 'state_advanced':
    case 'state_overridden': {
      const from = typeof p.from === 'string' ? p.from : null;
      const to = typeof p.to === 'string' ? p.to : null;
      if (!from || !to) return null;
      return `From ${projectStateLabel(from)} to ${projectStateLabel(to)}`;
    }
    case 'build_note_sent': {
      const chars = typeof p.chars === 'number' ? p.chars : null;
      if (chars === null) return null;
      return `${chars} character${chars === 1 ? '' : 's'}`;
    }
    case 'build_redispatched': {
      if (typeof p.dispatched !== 'boolean') return null;
      return p.dispatched
        ? 'Re-queued and handed to the worker'
        : 'Re-queued, but the worker could not be reached';
    }
    case 'job_canceled': {
      const jobKind = typeof p.jobKind === 'string' ? p.jobKind : null;
      return jobKind ? `${jobKindLabel(jobKind)} cancelled` : null;
    }
    case 'build_dispatch_failed': {
      const detail = typeof p.detail === 'string' ? p.detail : null;
      return detail;
    }
    case 'site_publish_requested': {
      const version = typeof p.version === 'number' ? p.version : null;
      if (version === null) return null;
      return `Version ${version} published${
        p.rebuildJobId ? ', rebuild queued' : ''
      }`;
    }
    case 'change_request_quoted': {
      const minor = typeof p.amountMinor === 'number' ? p.amountMinor : null;
      if (minor === null) return null;
      const currency = typeof p.currency === 'string' ? p.currency : 'eur';
      return `Quoted ${formatMinorAmount(minor, currency)}`;
    }
    case 'change_request_paid': {
      const minor = typeof p.amountMinor === 'number' ? p.amountMinor : null;
      if (minor === null) return null;
      if (minor === 0) return 'Paid, free of charge';
      const currency = typeof p.currency === 'string' ? p.currency : 'eur';
      return `Paid ${formatMinorAmount(minor, currency)}`;
    }
    default:
      return null;
  }
}
