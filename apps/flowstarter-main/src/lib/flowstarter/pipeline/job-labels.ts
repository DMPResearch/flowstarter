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
import type { Tone } from '@flowstarter/flow-design-system';

/** Kinds the queue actually runs today. Anything else falls back to sentence case. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  FULL_SITE_BUILD: 'Full site build',
  SITE_REBUILD: 'Publish client edit',
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
 * The build board's columns in colour, left to right in the order work
 * actually moves. Companion to `PROJECT_STATE_TONE` in `dashboard.constants.ts`
 * — that table colours the cross-project pipeline board's `ProjectState`
 * columns, this one colours a single project's build-job columns, which are
 * not project states and so need their own tone.
 *
 * `waiting` reads `neutral`: nothing has been picked up, which is the tone's
 * own meaning ("not switched on yet"). `building` is `accent`, the brand's
 * own hue, for the primary work. `checking` is `warn`, the same tone
 * `STAGE_TONE.build`/`internal_review` already use for "work an operator
 * owns" — checking and repairing a build is exactly that. `publishing` is
 * `info`, a plain factual last step. `done` is `ok`. `attention` — failed or
 * cancelled jobs waiting on a human decision — is `danger`, the tone the rest
 * of the system reserves for a real failure.
 */
export const BOARD_COLUMN_TONE: Readonly<Record<BoardColumnId, Tone>> = {
  waiting: 'neutral',
  building: 'accent',
  checking: 'warn',
  publishing: 'info',
  done: 'ok',
  attention: 'danger',
};

export function columnTone(id: BoardColumnId): Tone {
  return BOARD_COLUMN_TONE[id];
}

/** What `columnToneStyle` hands back: the two inline styles every kanban
 * column on the pipeline and build boards paints with. */
export interface ColumnToneStyle {
  /** The 3px rule along the top of the column panel. */
  rule: { background: string };
  /** The whisper wash on the column body, tone-soft fading to transparent. */
  wash: { background: string };
}

/**
 * The one recipe every kanban-shaped column shares, on both boards: a thin
 * tone rule along the panel's top edge, and a wash on the body that fades
 * from the tone to nothing — the same `-soft` alpha a quiet stat tile wears,
 * so this never invents a new one for `check-tone-contrast.mjs` to miss.
 *
 * `emphasis` swaps the whisper `-soft` wash for the louder `-emphasis` one,
 * the same swap `data-tone="attention"` makes on a stat tile, for the one
 * column that needs the eye to land on it: the build board's own `attention`
 * column, or a pipeline column currently holding a stalled card.
 */
export function columnToneStyle(tone: Tone, emphasis = false): ColumnToneStyle {
  const wash = `var(--fs-tone-${tone}-${emphasis ? 'emphasis' : 'soft'})`;
  return {
    rule: { background: `var(--fs-tone-${tone})` },
    wash: { background: `linear-gradient(to bottom, ${wash}, transparent)` },
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
  if (job.status === 'queued') return 'waiting';
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
  change_request_declined: 'Change request declined',
  change_request_done: 'Change request marked done',
  booking_cal_updated: 'Booking link updated',
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
