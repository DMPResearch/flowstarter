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
 *
 * The column and the card live in `PipelineColumns.tsx`: a page component can
 * only export the page itself, and the design gallery needs both to render
 * the board on fixture data without a signed-in session.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, GitBranch, RefreshCw } from 'lucide-react';
import { TeamDashboardShell } from '../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import { usePipelineBoard } from '@/hooks/usePipeline';
import {
  useCustomWorkLane,
  useMarkCustomWorkContacted,
} from '@/hooks/useCustomWorkLane';
import { useTranslations } from '@/lib/i18n';
import { PipelineBoard } from './PipelineColumns';
import { CustomWorkLane } from './CustomWorkLane';

export default function PipelineBoardPage() {
  const { data, isLoading, error, refetch, isFetching } = usePipelineBoard();
  const [stalledOnly, setStalledOnly] = useState(false);
  const { t: tStrict } = useTranslations();
  const t = tStrict as (key: string) => string;

  /**
   * The custom work lane is its own query. A failure to load it leaves the
   * board below intact, which is the point of not folding it into the pipeline
   * endpoint: these are two unrelated reads and an operator needs the second
   * one whether or not the first worked.
   */
  const lane = useCustomWorkLane();
  const markContacted = useMarkCustomWorkContacted();

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
            } need${data.stalledCount === 1 ? 's' : ''} attention`
          : 'Every project in the concierge flow, by state'
      }
      icon={<GitBranch className="h-5 w-5" aria-hidden />}
      // The board is the page, and a board is as wide as the screen lets it
      // be. The shell's default 1280px cap left dead space to the right of
      // the last column on a wide screen while the first column was clipped
      // off the left, which is the worst of both: boxed and scrolling at the
      // same time.
      maxWidth="full"
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
        <>
          {/* Above the columns, not among them: these are people with no
              project and no state, and a seventh column would read as a state
              a project can be in. */}
          {lane.data && lane.data.total > 0 && (
            <CustomWorkLane
              cards={lane.data.cards}
              waitingCount={lane.data.waitingCount}
              markingId={
                markContacted.isPending ? markContacted.variables ?? null : null
              }
              onMarkContacted={(id) => markContacted.mutate(id)}
              t={t}
            />
          )}
          <PipelineBoard
            columns={columns}
            emptyLabel={stalledOnly ? 'Nothing stalled here' : 'Empty'}
          />
        </>
      )}
    </TeamDashboardShell>
  );
}
