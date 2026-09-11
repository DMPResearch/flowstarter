'use client';

/**
 * The operator pipeline board.
 *
 * One screen that answers "what is stuck?". Columns are the lifecycle states in
 * order, cards are newest first, and anything the API flagged as stalled is
 * pulled to the top of its column and given a reason in plain language — a
 * queued build nobody picked up, a failed job, a project that has sat in one
 * state too long. The stalled count in the header is the number an operator
 * should be trying to drive to zero.
 */
import Link from 'next/link';
import {
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
} from 'react';
import { AlertTriangle, GitBranch, RefreshCw } from 'lucide-react';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  GlassSurface,
  type GlassSurfaceVariant,
  type Tone,
} from '@flowstarter/flow-design-system';
import { TeamDashboardShell } from '../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import { compactRelative } from '@/lib/format-utils';
import {
  usePipelineBoard,
  type PipelineCard as PipelineCardData,
} from '@/hooks/usePipeline';
import {
  BOARD_COLUMNS,
  boardColumnFor,
  jobKindLabel,
  jobStatusLabel,
} from '@/lib/flowstarter/pipeline/job-labels';

const STATE_LABEL: Record<ProjectState, string> = {
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
    variant?: GlassSurfaceVariant;
    interactive?: boolean;
  }
>;

/**
 * One card recipe. A stalled card keeps it and adds a left accent rule, so a
 * full column of stalls no longer reads as a wall of amber.
 */
function PipelineCard({ card }: { card: PipelineCardData }) {
  return (
    <GlassLinkCard
      href={`/admin/dashboard/projects/${card.workspaceId}`}
      variant="card"
      interactive
      className={`block p-3 ${
        card.stalled ? 'border-l-2 border-l-amber-500' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-sm font-semibold text-[var(--ls-ink)]">
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

export default function PipelineBoardPage() {
  const { data, isLoading, error, refetch, isFetching } = usePipelineBoard();
  const [stalledOnly, setStalledOnly] = useState(false);

  const columns = useMemo(() => {
    if (!data) return [];
    return data.columns.map((column) => ({
      ...column,
      // Stalled work first: the whole point of the board is that a problem is
      // visible without scrolling a column.
      cards: column.cards
        .filter((card) => !stalledOnly || card.stalled)
        .slice()
        .sort((a, b) => Number(b.stalled) - Number(a.stalled)),
    }));
  }, [data, stalledOnly]);

  return (
    <TeamDashboardShell
      title="Pipeline"
      subtitle={
        data
          ? `${data.total} project${data.total === 1 ? '' : 's'} · ${
              data.stalledCount
            } need attention`
          : 'Every project in the concierge flow, by state'
      }
      icon={<GitBranch className="h-5 w-5" aria-hidden />}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant={stalledOnly ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStalledOnly((v) => !v)}
          >
            <AlertTriangle className="h-4 w-4" />
            {stalledOnly ? 'Showing stalled' : 'Stalled only'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="text-sm text-red-500">
          {error instanceof Error
            ? error.message
            : 'Could not load the pipeline.'}
        </p>
      ) : isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-xl border border-[var(--ls-rule)] bg-[var(--ls-glass-bg)]"
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {columns.map((column) => (
            <GlassSurface
              key={column.state}
              as="section"
              variant="panel"
              className="flex min-h-[13rem] flex-col p-3"
            >
              <header className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--ls-rule)] pb-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--ls-ink-dim)]">
                  {STATE_LABEL[column.state]}
                </h2>
                <span className="flex items-center gap-1.5">
                  {column.stalledCount > 0 && (
                    <Pill tone={STALLED_TONE}>
                      {column.stalledCount} stalled
                    </Pill>
                  )}
                  <Pill mono tone={NEUTRAL_TONE}>
                    {column.cards.length}
                  </Pill>
                </span>
              </header>

              {column.cards.length === 0 ? (
                <p className="flex flex-1 items-center justify-center text-xs text-[var(--ls-ink-faint)]">
                  {stalledOnly ? 'Nothing stalled here' : 'Empty'}
                </p>
              ) : (
                <div className="space-y-2">
                  {column.cards.map((card) => (
                    <PipelineCard key={card.workspaceId} card={card} />
                  ))}
                </div>
              )}
            </GlassSurface>
          ))}
        </div>
      )}
    </TeamDashboardShell>
  );
}
