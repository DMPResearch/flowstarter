/**
 * The pipeline board's grid, column and card, pulled out of `page.tsx`.
 *
 * A page component can only ever have one export — the page itself — so the
 * design gallery (`/design-gallery`), which renders this board on fixture
 * data for a screenshot nobody has to sign in for, needs them as their own
 * module. `page.tsx` imports them back rather than keeping its own copy, so
 * the real board and the gallery's are pixel-for-pixel the same component,
 * down to the grid that sizes the columns.
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

/**
 * A card carries at most one colour, and only when something is wrong.
 *
 * Every card in the pipeline has a deposit, a quote and, usually, a job, so
 * colouring those said nothing: a column of cards each wearing a green
 * "Deposit paid" and a green "Finished" is a wall of green that flags the
 * normal case. The only job status an operator has to act on is `failed`, so
 * that is the only one with a tone of its own; everything else is the
 * neutral chip the rest of the board uses. A running job says it is running
 * by moving (see `RunningDot`), not by turning indigo.
 */
const JOB_TONE: Record<string, Tone> = {
  failed: 'danger',
};

/**
 * A stall is a thing that has gone wrong, not a thing on a to-do list, and it
 * is the one thing on this board allowed to be loud. It reads `danger`
 * everywhere it appears — the count pill in the header, the card's left rule
 * and its icon, the reasons under it — so the alarm is one colour rather than
 * amber in three places and red in a fourth.
 */
const STALLED_TONE: Tone = 'danger';

/**
 * "Something went wrong here", as a quiet note rather than a red box.
 *
 * Exported because the build board's job cards say the same thing about a
 * failed job and must say it in the same shape. A neutral fill keeps the
 * words readable and keeps the card's largest element out of the colour
 * argument; the 2px rule down the left edge is the danger, and it is the
 * same rule and the same red the stalled card wears on its own left edge, so
 * the two read as one mark rather than two.
 */
export const DANGER_NOTE =
  'rounded-r-lg border-l-2 border-l-[var(--fs-tone-danger)] bg-[var(--fs-tone-neutral-soft)]';

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

/**
 * One pill shape for the whole board. A tone supplies the three colours, or
 * the caller hands them in directly — which is what a column header does,
 * because a stage step's ink comes from the accent ladder rather than from a
 * tone's own token.
 */
function Pill({
  tone,
  style,
  mono = false,
  children,
}: {
  tone?: Tone;
  style?: React.CSSProperties;
  /** Counts read better as tabular figures; prose never does. */
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-5 ${
        mono ? 'font-mono tracking-[0.04em]' : ''
      }`}
      style={
        style ?? {
          background: `var(--fs-tone-${tone}-soft)`,
          color: `var(--fs-tone-${tone})`,
          boxShadow: `inset 0 0 0 1px var(--fs-tone-${tone}-edge)`,
        }
      }
    >
      {children}
    </span>
  );
}

/**
 * "This one is moving", said by moving rather than by colour.
 *
 * A running build used to be an indigo pill, which put a third hue on a card
 * that already had a green deposit and a green job status. The dot is the
 * card's own ink at a low alpha, so it reads as motion and nothing else, and
 * it holds still for anyone who has asked their system to stop animating.
 */
export function RunningDot() {
  return (
    <span
      aria-hidden
      className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70 motion-safe:animate-pulse"
    />
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
    dense?: boolean;
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
      dense
      className="block"
      // The left rule, from the tone token rather than a Tailwind palette, so
      // it is the same red the icon and the reasons below already use.
      style={
        card.stalled
          ? { borderLeft: `2px solid var(--fs-tone-${STALLED_TONE})` }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-2">
        {/* Two lines, not one truncated to an ellipsis: "Riverside
            Veterinary Clinic" has to read in full. Two is enough because the
            surfaces around it are `dense` — at the default glass padding a
            179px column leaves 91px for the name here, narrow enough that
            "Physiotherapy" does not fit on a line of its own and breaks
            mid-word. */}
        <span className="line-clamp-2 min-w-0 break-words text-sm font-semibold text-[var(--ls-ink)]">
          {card.businessName}
        </span>
        {card.stalled && (
          <AlertTriangle
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: `var(--fs-tone-${STALLED_TONE})` }}
            aria-label="Needs attention"
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Pill tone={NEUTRAL_TONE}>{money(card.quoteMinor, card.currency)}</Pill>
        <Pill tone={NEUTRAL_TONE}>
          {card.depositStatus === 'paid' ? 'Deposit paid' : 'No deposit'}
        </Pill>
        {card.latestJob && (
          <Pill tone={JOB_TONE[card.latestJob.status] ?? NEUTRAL_TONE}>
            {card.latestJob.status === 'running' && <RunningDot />}
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

      {/* The reasons read as a quiet note with a red edge, not as a red box.
          The card already says "danger" three times — the left rule, the
          icon, the count in the column header — and a fourth, filling the
          largest element on the card, is what turned one stalled project
          into a pink card among white ones. Neutral fill, neutral ink, and
          the same 2px danger rule as the card's own left edge to tie the two
          together. */}
      {card.stallReasons.length > 0 && (
        <ul className={`mt-2.5 space-y-1 px-2.5 py-2 ${DANGER_NOTE}`}>
          {card.stallReasons.map((reason) => (
            <li
              key={reason}
              className="text-[11px] leading-snug text-[var(--ls-ink-dim)]"
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
 * One column of the pipeline board: a `ProjectState`'s worth of cards in a
 * plain glass panel.
 *
 * The state's place in the sequence is the only thing colour says here (see
 * `PROJECT_STATE_TONE`): a 2px rule along the top and the header label, both
 * stepping through the accent ladder, with the count pill following the
 * header's ink. The body is always the panel's own fill.
 *
 * It used to wash red while the column held a stalled card. The wash is a
 * top-down gradient, so what it actually tinted was the first card in the
 * column — and since stalled cards sort to the top, that card was always the
 * stalled one, which is how one stuck project came to read as a pink card.
 * The stall is still the loudest thing on the board, but it says so on the
 * card it belongs to (left rule, icon) and in the header count, not by
 * colouring the panel behind it.
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
  const { rule, wash, ink, chip } = columnToneStyle(tone);

  return (
    <GlassSurface
      as="section"
      variant="panel"
      dense
      className="relative flex min-h-[13rem] flex-col overflow-hidden"
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px]"
        style={rule}
      />

      {/* One header shape for all six columns: the same size, weight and
          tracking whatever the column's colour, and the count pushed to the
          right edge by `justify-between`. The `min-h` is two lines of the
          title, so "Agents working" wrapping does not drop that one column's
          divider below its neighbours' and leave the row of rules ragged. */}
      <header className="mb-3 flex min-h-[2rem] items-center justify-between gap-2 border-b border-[var(--ls-rule)] pb-2.5">
        <h2
          className="text-xs font-semibold uppercase tracking-[0.08em]"
          style={ink}
        >
          {STATE_LABEL[state]}
        </h2>
        <span className="flex shrink-0 items-center gap-1.5">
          {stalledCount > 0 && (
            <Pill tone={STALLED_TONE}>{stalledCount} stalled</Pill>
          )}
          <Pill mono style={chip}>
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

/**
 * The board itself: six columns across the full width available to it.
 *
 * `grid-flow-col` with `auto-cols-[minmax(11rem,1fr)]` is what makes the row
 * fill rather than fit. `1fr` lets every column take an equal share of
 * whatever is left over, so there is never dead space to the right of the
 * last one; `11rem` is the floor below which it stops sharing and starts
 * scrolling instead.
 *
 * That floor is measured, not picked. At 1440 with the sidebar expanded the
 * admin content box is 1440 − 240 (sidebar) − 64 (the shell's `lg:px-8`
 * gutters) = 1136px, and six columns with five 12px gutters leave 1076px to
 * divide: 179px each. 176px is the nearest round floor under that, so six
 * columns fit on a 1440 screen with room to spare and settle at ~179px wide,
 * and anything narrower scrolls. The old 240px floor needed 1520px and so
 * scrolled on every screen anyone actually uses, which is why the board was
 * usually seen with its first column half off the left edge.
 *
 * `items-start` keeps a column's height its own — a column holding a stalled
 * card's extra reasons box should not stretch every quiet column beside it
 * into a tall, mostly empty panel.
 */
export function PipelineBoard({
  columns,
  emptyLabel,
}: {
  columns: {
    state: ProjectState;
    cards: PipelineCardData[];
    stalledCount: number;
  }[];
  emptyLabel?: string;
}) {
  return (
    <div
      data-testid="pipeline-board"
      className="-mx-1 grid grid-flow-col auto-cols-[minmax(11rem,1fr)] items-start gap-3 overflow-x-auto px-1 pb-2"
    >
      {columns.map((column) => (
        <PipelineBoardColumn
          key={column.state}
          state={column.state}
          cards={column.cards}
          stalledCount={column.stalledCount}
          emptyLabel={emptyLabel}
        />
      ))}
    </div>
  );
}
