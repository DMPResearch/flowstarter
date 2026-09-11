'use client';

/**
 * Pipeline tab — what happened to this project, and what an operator can do
 * about it.
 *
 * Three panels, in the order a stuck project gets diagnosed: where it is now
 * and where it may go; the build board, because the usual failure is a build
 * sitting unpicked and the column it is parked in says so at a glance; and the
 * append-only event timeline underneath as the record of every intervention.
 *
 * The board's columns are stages of one build, not a queue an operator drags
 * cards between: the worker moves a job, and `boardColumnFor` reads its status
 * and phase to decide where it belongs. Nothing here is draggable on purpose.
 *
 * The dropdown only offers the transitions the server allows, but the server
 * is the guard — this component reads `allowedTransitions` from the same map
 * the API enforces so the two cannot disagree, and a rejected move surfaces
 * the server's own message rather than a generic failure.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRightCircle,
  Ban,
  History,
  MessagesSquare,
  RefreshCw,
} from 'lucide-react';
import { ProjectState } from '@flowstarter/agentic-codegen/src/flowstarter/types';
import { Pill, type Tone } from '@flowstarter/flow-design-system';
import { DANGER_NOTE, RunningDot } from '../../../pipeline/PipelineColumns';
import { ShellCard } from '../../../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { compactRelative } from '@/lib/format-utils';
import {
  BOARD_COLUMNS,
  actorLabel,
  boardColumnFor,
  columnTone,
  columnToneStyle,
  errorCodeLabel,
  eventKindLabel,
  eventSummary,
  jobKindLabel,
  jobStatusLabel,
  phaseLabel,
  projectStateLabel,
  type BoardColumnId,
} from '@/lib/flowstarter/pipeline/job-labels';
import {
  useCancelPipelineJob,
  useOverrideProjectState,
  usePipelineDetail,
  useRedispatchBuild,
  type PipelineEvent,
  type PipelineJobDetail,
} from '@/hooks/usePipeline';
import type { Project } from './form-helpers';
import { BuildConversation } from './BuildConversation';
import { BuildLog } from './BuildLog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * Same rule as the cross-project board: a job card carries at most one
 * colour, and only when something is wrong.
 *
 * Four of the five statuses here used to have a hue of their own — sky,
 * indigo, emerald, red — so a healthy build board was a row of coloured
 * chips in which the one red chip had to compete with three others. `failed`
 * is the only status an operator has to act on, so it is the only one with a
 * tone; `running` says it is running by moving instead (`RunningDot`).
 */
const JOB_TONE: Record<string, Tone> = {
  failed: 'danger',
};

const NEUTRAL_TONE: Tone = 'neutral';

/** The three colours a tone supplies, as the chip and box styles want them. */
function toneFill(tone: Tone): React.CSSProperties {
  return {
    background: `var(--fs-tone-${tone}-soft)`,
    color: `var(--fs-tone-${tone})`,
    boxShadow: `inset 0 0 0 1px var(--fs-tone-${tone}-edge)`,
  };
}

/**
 * Kinds the build worker runs, and so the only ones with a conversation to
 * open. Everything else is a card you can read, not talk to.
 */
const CONVERSATIONAL_KINDS = new Set(['FULL_SITE_BUILD', 'SITE_REBUILD']);

const LIVE_STATUSES = new Set(['queued', 'running']);

function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-5"
      style={toneFill(JOB_TONE[status] ?? NEUTRAL_TONE)}
    >
      {status === 'running' && <RunningDot />}
      {jobStatusLabel(status)}
    </span>
  );
}

/**
 * One job, as a card in its stage's column.
 *
 * Compact by design: the card answers "what is this and is it moving", and
 * anything longer — the agents' own words, the operator's notes — is one click
 * away in the conversation panel rather than crammed in here.
 */
function BuildCard({
  job,
  projectId,
  onOpen,
}: {
  job: PipelineJobDetail;
  projectId: string;
  onOpen: () => void;
}) {
  const redispatch = useRedispatchBuild(projectId);
  const cancel = useCancelPipelineJob(projectId);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const busy = redispatch.isPending || cancel.isPending;
  const canTalk = CONVERSATIONAL_KINDS.has(job.kind);

  const onRedispatch = async () => {
    try {
      const result = await redispatch.mutateAsync({ jobId: job.id });
      toast[result.dispatched ? 'success' : 'warning'](
        result.dispatched
          ? 'Build re-queued and handed to the worker'
          : `Build re-queued, but the worker could not be reached: ${
              result.dispatchError ?? 'unknown error'
            }`
      );
    } catch (e) {
      toast.error(errorMessage(e, 'Re-dispatch failed'));
    }
  };

  const onCancel = async () => {
    try {
      await cancel.mutateAsync({ jobId: job.id, reason: reason.trim() });
      toast.success('Job cancelled');
      setCancelling(false);
      setReason('');
    } catch (e) {
      toast.error(errorMessage(e, 'Cancel failed'));
    }
  };

  return (
    <article
      data-testid="build-card"
      // A div and not a button: the card carries its own buttons, and nesting
      // those inside one is invalid. Keyboard users get the same opening.
      role={canTalk ? 'button' : undefined}
      tabIndex={canTalk ? 0 : undefined}
      onClick={canTalk ? onOpen : undefined}
      onKeyDown={
        canTalk
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      className={`rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] p-2.5 text-left transition-colors ${
        canTalk ? 'cursor-pointer hover:border-[var(--purple-primary)]/60' : ''
      }`}
    >
      {/* Title on its own line: a column is narrow, and a truncated kind is
          exactly the enum-shaped mystery this board exists to remove. */}
      <p className="text-[13px] font-semibold leading-snug text-[var(--fs-ink)]">
        {jobKindLabel(job.kind)}
      </p>
      <div className="mt-1.5">
        <StatusChip status={job.status} />
      </div>

      {job.latestPhase && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-[var(--fs-ink-dim)]">
          {/* The status chip above already carries the running dot; the
              phase line does not need a second, purple one of its own. */}
          <span className="min-w-0">{phaseLabel(job.latestPhase)}</span>
        </p>
      )}

      <p className="mt-1 text-[11px] text-[var(--fs-ink-faint)]">
        Attempt {job.attemptCount} of {job.maxAttempts} ·{' '}
        {humanDuration(job.ageMs)} since last change
      </p>

      {job.lastReply && (
        <p className="mt-1.5 line-clamp-2 text-[11px] italic leading-snug text-[var(--fs-ink-dim)]">
          “{job.lastReply}”
        </p>
      )}

      {job.errorCode && (
        <p
          className={`mt-1.5 line-clamp-2 px-2 py-1 text-[11px] leading-snug text-[var(--fs-ink-dim)] ${DANGER_NOTE}`}
          title={job.errorDetail ?? undefined}
        >
          {errorCodeLabel(job.errorCode)}
          {job.errorDetail ? `: ${job.errorDetail}` : ''}
        </p>
      )}

      <div
        className="mt-2 flex flex-wrap items-center gap-1.5"
        // The card itself opens the conversation; its buttons do their own job.
        onClick={(e) => e.stopPropagation()}
      >
        {canTalk && (
          <Button size="xs" variant="outline" onClick={onOpen}>
            <MessagesSquare className="h-3.5 w-3.5" />
            Talk to the agents
          </Button>
        )}
        {job.canRedispatch && (
          <Button
            size="xs"
            variant="ghost"
            onClick={onRedispatch}
            disabled={busy}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                redispatch.isPending ? 'animate-spin' : ''
              }`}
            />
            Re-dispatch
          </Button>
        )}
        {job.canCancel && !cancelling && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setCancelling(true)}
            disabled={busy}
          >
            <Ban className="h-3.5 w-3.5" />
            Cancel
          </Button>
        )}
      </div>

      {cancelling && (
        <div
          className="mt-2.5 space-y-2 border-t border-[var(--fs-rule)] pt-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <Label htmlFor={`cancel-reason-${job.id}`}>
            Why is this job being cancelled?
          </Label>
          <Textarea
            id={`cancel-reason-${job.id}`}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Worker died mid-build; restarting from a clean queue."
          />
          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setCancelling(false);
                setReason('');
              }}
            >
              Never mind
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={onCancel}
              disabled={reason.trim().length < 3 || cancel.isPending}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel job'}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * The conversation, in a panel pinned to the right edge.
 *
 * The Dialog primitive brings the overlay, the escape key and the focus trap;
 * the inline style is what turns a centred modal into a side panel, and it is
 * inline because a class would have to fight the primitive's own centring.
 */
function ConversationPanel({
  projectId,
  job,
  onClose,
}: {
  projectId: string;
  job: PipelineJobDetail;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-w-none flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-none"
        style={{
          top: 0,
          right: 0,
          bottom: 0,
          left: 'auto',
          // Both, deliberately: the primitive centres itself with Tailwind v4's
          // `translate` property, which `transform: none` does not undo.
          transform: 'none',
          translate: 'none',
          width: 'min(32rem, 100vw)',
          height: '100dvh',
        }}
      >
        <div className="border-b border-[var(--fs-rule)] px-5 py-4">
          <DialogTitle className="flex items-center gap-2 pr-8 text-base">
            {jobKindLabel(job.kind)}
            <StatusChip status={job.status} />
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            {job.latestPhase
              ? phaseLabel(job.latestPhase)
              : 'No phase reported yet.'}
          </DialogDescription>
          {job.errorCode && (
            <p
              className="mt-2 text-xs text-red-500"
              title={job.errorDetail ?? undefined}
            >
              {errorCodeLabel(job.errorCode)}
              {job.errorDetail ? `: ${job.errorDetail}` : ''}
            </p>
          )}
        </div>
        <Tabs defaultValue="conversation" className="min-h-0 flex-1 gap-0">
          <div className="border-b border-[var(--fs-rule)] px-5 pt-3 pb-3">
            {/* The switch has to read at a glance in a dark-panel context, so
                the active tab is the same filled purple pill the client
                editor uses, not a faint white-on-grey highlight. */}
            <TabsList className="h-auto w-fit gap-1 rounded-full border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)] p-1">
              {(
                [
                  ['conversation', 'Conversation'],
                  ['log', 'Full log'],
                ] as const
              ).map(([value, label]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="rounded-full px-4 py-1.5 text-xs font-semibold text-[var(--fs-ink-dim)] transition-colors hover:text-[var(--fs-ink)] data-[state=active]:bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] data-[state=active]:text-white data-[state=active]:shadow-lg data-[state=active]:shadow-[var(--purple-primary-lightest)]"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent
            value="conversation"
            className="min-h-0 overflow-y-auto px-5 pb-5"
          >
            <BuildConversation
              projectId={projectId}
              jobId={job.id}
              status={job.status}
            />
          </TabsContent>
          <TabsContent value="log" className="min-h-0 px-5 pb-5">
            <BuildLog
              projectId={projectId}
              jobId={job.id}
              status={job.status}
              className="h-full"
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One row of the audit trail: what happened, who did it, and — for the kinds
 * that have a rule — a one-line summary read from the payload. The payload
 * itself is never the headline; it is one click away behind "Details" for
 * whoever needs to see the raw row.
 */
function TimelineRow({ event }: { event: PipelineEvent }) {
  const actor = actorLabel(event.actor);
  const summary = eventSummary(event.kind, event.payload);
  const hasPayload =
    event.payload != null &&
    typeof event.payload === 'object' &&
    Object.keys(event.payload as Record<string, unknown>).length > 0;

  return (
    <li className="rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--fs-ink)]">
          {eventKindLabel(event.kind)}
        </span>
        <span
          className="text-[11px] text-[var(--fs-ink-faint)]"
          title={actor.title ?? undefined}
        >
          {actor.label} · {compactRelative(event.createdAt)}
        </span>
      </div>
      {summary && (
        <p className="mt-1 text-[11px] text-[var(--fs-ink-dim)]">{summary}</p>
      )}
      {hasPayload && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-[var(--fs-ink-faint)]">
            Details
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-[var(--fs-ink-faint)]">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

export function PipelineTab({ project }: { project: Project }) {
  const { data, isLoading, error, refetch, isFetching } = usePipelineDetail(
    project.id
  );
  const override = useOverrideProjectState(project.id);
  const [nextState, setNextState] = useState<string>('');
  const [reason, setReason] = useState('');
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  const onOverride = async () => {
    try {
      const result = await override.mutateAsync({
        toState: nextState as ProjectState,
        reason: reason.trim(),
      });
      toast.success(
        `Moved to ${projectStateLabel(result.project.projectState)}`
      );
      setNextState('');
      setReason('');
    } catch (e) {
      // The server's message names the illegal move and lists what is allowed;
      // a generic "failed" would throw that away.
      toast.error(errorMessage(e, 'State change failed'));
    }
  };

  if (error) {
    return (
      <ShellCard>
        <p className="text-sm text-red-500">
          {errorMessage(error, 'Could not load the pipeline for this project.')}
        </p>
      </ShellCard>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)]"
          />
        ))}
      </div>
    );
  }

  const { project: card, allowedTransitions, jobs, events } = data;

  const byColumn = new Map<BoardColumnId, PipelineJobDetail[]>(
    BOARD_COLUMNS.map((column) => [column.id, []])
  );
  for (const job of jobs) {
    byColumn.get(boardColumnFor(job))?.push(job);
  }

  const openJob = jobs.find((job) => job.id === openJobId) ?? null;
  const liveCount = jobs.filter((job) => LIVE_STATUSES.has(job.status)).length;

  return (
    <div className="space-y-5">
      <ShellCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-[var(--fs-ink-faint)]">
              Current state
            </p>
            <p className="text-lg font-semibold text-[var(--fs-ink)]">
              {projectStateLabel(card.projectState)}
            </p>
            <p className="mt-1 text-xs text-[var(--fs-ink-faint)]">
              Here for {humanDuration(card.timeInStateMs)} · deposit{' '}
              {card.depositStatus}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>

        {/* The same quiet note the board's cards use, for the same reason:
            an amber-filled box with amber text was a third hue on a panel
            that already says everything else in ink. The icon carries the
            colour, the rule carries the edge, the words stay readable. */}
        {card.stallReasons.length > 0 && (
          <div className={`mt-4 p-3 ${DANGER_NOTE}`}>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--fs-ink)]">
              <AlertTriangle
                className="h-3.5 w-3.5"
                style={{ color: 'var(--fs-tone-danger)' }}
                aria-hidden
              />
              Needs attention
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {card.stallReasons.map((r) => (
                <li key={r} className="text-xs text-[var(--fs-ink-dim)]">
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 space-y-3 border-t border-[var(--fs-rule)] pt-4">
          <div>
            <Label>Move to</Label>
            <p className="mb-2 text-xs text-[var(--fs-ink-faint)]">
              Only neighbouring states are offered, and the server enforces the
              same rule. Two steps take two moves, each with its own reason.
            </p>
            <Select value={nextState} onValueChange={setNextState}>
              <SelectTrigger
                className="mt-1"
                disabled={allowedTransitions.length === 0}
              >
                <SelectValue placeholder="Choose a state…" />
              </SelectTrigger>
              <SelectContent>
                {allowedTransitions.map((state) => (
                  <SelectItem key={state} value={state}>
                    {projectStateLabel(state)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="state-override-reason">Reason</Label>
            <Textarea
              id="state-override-reason"
              rows={2}
              className="mt-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Stripe webhook never arrived; deposit confirmed manually in the dashboard."
            />
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={onOverride}
              disabled={
                !nextState || reason.trim().length < 3 || override.isPending
              }
            >
              <ArrowRightCircle className="h-4 w-4" />
              {override.isPending ? 'Moving…' : 'Move project'}
            </Button>
          </div>
        </div>
      </ShellCard>

      <ShellCard>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--fs-ink-dim)]">
            Build board
          </h3>
          <p className="text-xs text-[var(--fs-ink-faint)]">
            {jobs.length === 0
              ? 'No jobs yet'
              : `${jobs.length} job${jobs.length === 1 ? '' : 's'}${
                  liveCount > 0 ? ` · ${liveCount} in flight` : ''
                } · open a card to talk to the agents`}
          </p>
        </div>

        {jobs.length === 0 ? (
          <p className="text-xs text-[var(--fs-ink-faint)]">
            No jobs yet. A full-site build is enqueued when a deposit is
            recorded.
          </p>
        ) : (
          <div
            data-testid="build-board"
            // `minmax(11rem,1fr)` is the same floor the cross-project board
            // uses, and for the same measured reason: six columns of 240px
            // need 1520px, which no admin screen has beside the sidebar, so
            // the board scrolled with its first column clipped on every
            // machine. At 176px six fit, `1fr` shares out the remainder so
            // there is no dead space at the right, and `items-start` keeps
            // one column's content height from stretching the rest.
            className="-mx-1 grid grid-flow-col auto-cols-[minmax(11rem,1fr)] items-start gap-3 overflow-x-auto px-1 pb-2"
          >
            {BOARD_COLUMNS.map((column) => {
              const columnJobs = byColumn.get(column.id) ?? [];
              // `attention` holds the failed and cancelled jobs, so it is the
              // one column here that is always broken by definition and the
              // one that always wears the red wash — the same wash a pipeline
              // column takes while it is holding a stalled card.
              const tone = columnTone(column.id);
              const { rule, wash, ink, chip } = columnToneStyle(
                tone,
                column.id === 'attention'
              );
              return (
                <section
                  key={column.id}
                  aria-label={column.title}
                  className="relative flex min-h-[9rem] flex-col overflow-hidden rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)]/40 p-2"
                >
                  <span
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-[2px]"
                    style={rule}
                  />

                  {/* Same header shape in all six: one size, one weight, one
                      tracking, the count hard against the right edge, and a
                      two-line floor so "Needs attention" wrapping does not
                      leave that column's divider lower than the rest. */}
                  <header className="mb-2 flex min-h-[1.875rem] items-center justify-between gap-1.5 border-b border-[var(--fs-rule)] pb-2">
                    <h4
                      className="text-[11px] font-semibold uppercase tracking-[0.08em]"
                      style={ink}
                    >
                      {column.title}
                    </h4>
                    <Pill className="shrink-0 font-mono" style={chip}>
                      {columnJobs.length}
                    </Pill>
                  </header>

                  <div
                    className="-mx-2 -mb-2 flex flex-1 flex-col px-2 pb-2"
                    style={wash}
                  >
                    {columnJobs.length === 0 ? (
                      <p className="px-1 py-1 text-[11px] leading-snug text-[var(--fs-ink-faint)]">
                        {column.hint}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {columnJobs.map((job) => (
                          <BuildCard
                            key={job.id}
                            job={job}
                            projectId={project.id}
                            onOpen={() => setOpenJobId(job.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </ShellCard>

      {openJob && (
        <ConversationPanel
          projectId={project.id}
          job={openJob}
          onClose={() => setOpenJobId(null)}
        />
      )}

      <ShellCard>
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-[var(--fs-ink-dim)]">
          <History className="h-4 w-4" aria-hidden />
          Timeline
        </h3>
        {events.length === 0 ? (
          <p className="text-xs text-[var(--fs-ink-faint)]">
            Nothing recorded for this project yet.
          </p>
        ) : (
          <ol className="space-y-2">
            {events.map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </ShellCard>
    </div>
  );
}
