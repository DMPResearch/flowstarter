/**
 * The pipeline board's column and card, pulled out of `page.tsx`.
 *
 * A page component can only ever have one export — the page itself — so the
 * design gallery (`/about/design-gallery`), which renders this board on
 * fixture data for a screenshot nobody has to sign in for, needs the column
 * and the card as their own module. `page.tsx` imports them back rather than
 * keeping its own copy, so the real board and the gallery's are pixel-for-
 * pixel the same component.
 */
import Link from 'next/link';
import type { ComponentProps, ComponentType } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  GlassSurface,
  type GlassSurfaceVariant,
  type Tone,
} from '@flowstarter/flow-design-system';
import { compactRelative } from '@/lib/format-utils';
import type { PipelineCard as PipelineCardData } from '@/hooks/usePipeline';
import {
  BOARD_COLUMNS,
  boardColumnFor,
  columnToneStyle,
  jobKindLabel,
  jobStatusLabel,
} from '@/lib/flowstarter/pipeline/job-labels';
import { projectStateTone } from '../components/dashboard.constants';

export const STATE_LABEL: Record<ProjectState, string> = {
  [ProjectState.INTAKE]: 'Intake',
  [ProjectState.PREVIEW_READY]: 'Preview ready',
  [ProjectState.DEPOSIT_PAID]: 'Deposit paid',
  [ProjectState.AGENTS_WORKING]: 'Agents working',
  [ProjectState.HUMAN_QA]: 'Human QA',
  [ProjectState.LIVE_SUBSCRIPTION]: 'Live',
};

/** One chip shape for the whole board; a tone only supplies colour. */
const NEUTRAL_TONE: Tone = 'neutral';

const JOB_TONE: Record<string, Tone> = {
  queued: 'info',
  running: 'accent',
  succeeded: 'ok',
  failed: 'danger',
  canceled: 'neutral',
};

const DEPOSIT_TONE: Record<string, Tone> = {
  paid: 'ok',
  refunded: 'warn',
};

const STALLED_TONE: Tone = 'warn';

/** The build-board column a job is in, by name. This board has no phase data, so a running job reads as its first stage. */
function buildStageLabel(status: string): string {
  const id = boardColumnFor({ status, latestPhase: null });
  return BOARD_COLUMNS.find((column) => column.id === id)?.title ?? '';
}

/** Mirrors `formatDuration` in the board lib, for values computed client-side. */
function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function money(minor: number, currency: string): string {
  if (!minor) return 'No quote';
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(0)} ${currency.toUpperCase()}`;
  }
}

function Pill({
  tone,
  mono = false,
  children,
}: {
  tone: Tone;
  /** Counts read better as tabular figures; prose never does. */
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-5 ${
        mono ? 'font-mono tracking-[0.04em]' : ''
      }`}
      style={{
        background: `var(--fs-tone-${tone}-soft)`,
        color: `var(--fs-tone-${tone})`,
        boxShadow: `inset 0 0 0 1px var(--fs-tone-${tone}-edge)`,
      }}
    >
      {children}
    </span>
  );
}

/**
 * GlassSurface typed for `as={Link}`. The base props type does not know
 * which extra props the element passed to `as` accepts, so this narrows it
 * locally for the one call site that needs `href`.
 */
const GlassLinkCard = GlassSurface as unknown as ComponentType<
  ComponentProps<typeof Link> & {
    as: typeof Link;
    variant?: GlassSurfaceVariant;
    interactive?: boolean;
  }
>;

/**
 * One card recipe. A stalled card keeps it and adds a left accent rule, so a
 * full column of stalls no longer reads as a wall of amber. The card itself
 * stays neutral glass — tone lives in the column around it, not in every
 * card inside it.
 */
export function PipelineCard({ card }: { card: PipelineCardData }) {
  return (
    <GlassLinkCard
      as={Link}
      href={`/admin/dashboard/projects/${card.workspaceId}`}
      variant="card"
      interactive
      className={`block p-3 ${
        card.stalled ? 'border-l-2 border-l-amber-500' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Two lines, not one truncated to an ellipsis: "Riverside
            Veterinary Clinic" has to read in full, and a column narrow
            enough to need more than that is a column that should scroll
            rather than clip a name. */}
        <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold text-[var(--ls-ink)]">
          {card.businessName}
        </span>
        {card.stalled && (
          <AlertTriangle
            className="h-3.5 w-3.5 shrink-0 text-amber-500"
            aria-label="Needs attention"
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Pill tone={NEUTRAL_TONE}>{money(card.quoteMinor, card.currency)}</Pill>
        <Pill tone={DEPOSIT_TONE[card.depositStatus] ?? NEUTRAL_TONE}>
          {card.depositStatus === 'paid' ? 'Deposit paid' : 'No deposit'}
        </Pill>
        {card.latestJob && (
          <Pill tone={JOB_TONE[card.latestJob.status] ?? NEUTRAL_TONE}>
            {jobKindLabel(card.latestJob.kind)} ·{' '}
            {jobStatusLabel(card.latestJob.status)}
            {/* A running job says which stage it is at, the same word the
                project's own build board uses. */}
            {card.latestJob.status === 'running' &&
              ` · ${buildStageLabel(card.latestJob.status)}`}
          </Pill>
        )}
      </div>

      <p className="mt-2 text-[11px] text-[var(--ls-ink-dim)]">
        In state {humanDuration(card.timeInStateMs)} · created{' '}
        {compactRelative(card.createdAt)}
      </p>

      {card.stallReasons.length > 0 && (
        <ul
          className="mt-2.5 space-y-1 rounded-lg px-2.5 py-2"
          style={{
            background: 'var(--fs-tone-warn-soft)',
            boxShadow: 'inset 0 0 0 1px var(--fs-tone-warn-edge)',
          }}
        >
          {card.stallReasons.map((reason) => (
            <li
              key={reason}
              className="fs-tone-text text-[11px] leading-snug"
              data-tone="warn"
            >
              {reason}
            </li>
          ))}
        </ul>
      )}
    </GlassLinkCard>
  );
}

/**
 * One column of the pipeline board: a `ProjectState`'s worth of cards, in a
 * panel toned to that state (see `PROJECT_STATE_TONE`). The header label and
 * the count pill carry the tone, a 3px rule tops the panel, and a whisper
 * wash sits behind the cards — stronger, so the eye lands on it, when the
 * column currently holds a stalled card.
 */
export function PipelineBoardColumn({
  state,
  cards,
  stalledCount,
  emptyLabel = 'Empty',
}: {
  state: ProjectState;
  cards: PipelineCardData[];
  stalledCount: number;
  emptyLabel?: string;
}) {
  const tone = projectStateTone(state);
  const { rule, wash } = columnToneStyle(tone, stalledCount > 0);

  return (
    <GlassSurface
      as="section"
      variant="panel"
      className="relative flex min-h-[13rem] flex-col overflow-hidden p-3"
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={rule}
      />

      <header className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--ls-rule)] pb-2.5">
        <h2
          className="fs-tone-text text-xs font-semibold uppercase tracking-wide"
          data-tone={tone}
        >
          {STATE_LABEL[state]}
        </h2>
        <span className="flex items-center gap-1.5">
          {stalledCount > 0 && (
            <Pill tone={STALLED_TONE}>{stalledCount} stalled</Pill>
          )}
          <Pill mono tone={tone}>
            {cards.length}
          </Pill>
        </span>
      </header>

      <div className="-mx-3 -mb-3 flex flex-1 flex-col px-3 pb-3" style={wash}>
        {cards.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-xs text-[var(--ls-ink-faint)]">
            {emptyLabel}
          </p>
        ) : (
          <div className="space-y-2">
            {cards.map((card) => (
              <PipelineCard key={card.workspaceId} card={card} />
            ))}
          </div>
        )}
      </div>
    </GlassSurface>
  );
}
