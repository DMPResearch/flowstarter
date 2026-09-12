'use client';

/**
 * Changes tab: what the client asked for after launch, priced by us, and done
 * by us.
 *
 * Each request shows the classifier's labels and the rule table's suggested
 * price, pre-filled into a quote form an operator edits before sending. The
 * client accepts and pays in their editor; the request comes back here as
 * paid, and then there is a button that does the work.
 *
 * That last part is new, and it is the whole point of this screen. A paid card
 * used to offer one thing, "Mark done", which moved a status and shipped
 * nothing -- a client paid EUR 190 on 2026-09-12 for a change the product had
 * no route to make. "Build this change" queues a CHANGE_REQUEST_BUILD: an
 * agent pass over the site the client already has, seeded from the manifest
 * their editor last wrote and carrying their own rights-confirmed pictures.
 * The build's conversation is shown inline, in the same component the pipeline
 * tab uses, so an operator watches the work rather than guessing at it.
 *
 * "Mark done" survives as a manual override for work that genuinely happened
 * outside the product, and now costs a typed reason that is stored on the
 * request. The difference between "a build shipped this" and "a person says
 * this is handled" has to stay legible after everyone involved has forgotten.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { BadgeEuro, Check, Hammer, XCircle } from 'lucide-react';
import { ShellCard } from '../../../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { compactRelative } from '@/lib/format-utils';
import {
  useBuildChangeRequest,
  useChangeRequests,
  useQuoteChangeRequest,
  useSetChangeRequestStatus,
  type ChangeRequestView,
} from '@/hooks/useChangeRequests';
import { BuildConversation } from './BuildConversation';
import type { Project } from './form-helpers';

/** Lifecycle states in which a delivered site exists to be changed. */
const BUILDABLE_STATES = new Set(['HUMAN_QA', 'LIVE_SUBSCRIPTION']);

const NEUTRAL_TONE =
  'border-[var(--fs-rule)] bg-transparent text-[var(--fs-ink-dim)]';
const STATUS_TONE: Record<string, string> = {
  requested: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  quoted:
    'border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  accepted:
    'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  paid: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  done: NEUTRAL_TONE,
  declined: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
};
const STATUS_LABEL: Record<string, string> = {
  requested: 'Needs a quote',
  quoted: 'Quoted, waiting on the client',
  accepted: 'Accepted, in checkout',
  paid: 'Paid, ready to build',
  done: 'Done',
  declined: 'Declined',
};

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}

function RequestCard({
  request,
  projectId,
  projectState,
}: {
  request: ChangeRequestView;
  projectId: string;
  projectState: string;
}) {
  const quote = useQuoteChangeRequest(projectId);
  const setStatus = useSetChangeRequestStatus(projectId);
  const build = useBuildChangeRequest(projectId);
  const [amount, setAmount] = useState(() =>
    ((request.quoteMinor ?? request.suggestedQuoteMinor ?? 0) / 100).toFixed(2)
  );
  const [note, setNote] = useState(request.quoteNote ?? '');
  const [buildNote, setBuildNote] = useState('');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const busy = quote.isPending || setStatus.isPending || build.isPending;
  const canQuote =
    request.status === 'requested' || request.status === 'quoted';
  const canBuild =
    request.status === 'paid' && BUILDABLE_STATES.has(projectState);
  // The job id survives the mutation, so the conversation keeps rendering
  // after the list refetches and the card re-reads the row.
  const jobId = build.data?.jobId ?? request.buildJobId;

  const onQuote = async () => {
    const minor = Math.round(Number(amount) * 100);
    if (!Number.isFinite(minor) || minor < 0) {
      toast.error('Enter an amount');
      return;
    }
    try {
      await quote.mutateAsync({
        changeId: request.id,
        amountMinor: minor,
        note,
      });
      toast.success('Quote sent. The client sees it in their editor.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the quote');
    }
  };
  const onStatus = async (status: 'declined' | 'done') => {
    try {
      await setStatus.mutateAsync({
        changeId: request.id,
        status,
        ...(status === 'done' ? { reason: reason.trim() } : {}),
      });
      setOverride(false);
      setReason('');
      toast.success(status === 'done' ? 'Marked done' : 'Declined');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update');
    }
  };
  const onBuild = async () => {
    try {
      const started = await build.mutateAsync({
        changeId: request.id,
        note: buildNote.trim(),
      });
      setBuildNote('');
      toast.success(
        started.created
          ? `Build queued with ${started.assets.length} of the client's files.`
          : 'A build for this project is already running; this joined it.'
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the build');
    }
  };

  return (
    <li
      data-testid="change-request-card"
      className="rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-sm text-[var(--fs-ink)]">
            {request.request}
          </p>
          <p className="mt-1 text-[11px] text-[var(--fs-ink-faint)]">
            {compactRelative(request.createdAt)} ·{' '}
            {request.matchedRules.length > 0
              ? request.matchedRules.join(', ')
              : request.classification}
            {typeof request.suggestedQuoteMinor === 'number' && (
              <>
                {' '}
                · suggested{' '}
                {formatMoney(request.suggestedQuoteMinor, request.currency)}
              </>
            )}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5 ${
            STATUS_TONE[request.status] ?? NEUTRAL_TONE
          }`}
        >
          {STATUS_LABEL[request.status] ?? request.status}
        </span>
      </div>

      {request.quoteMinor !== null && !canQuote && (
        <p className="mt-2 text-xs text-[var(--fs-ink-dim)]">
          Quoted {formatMoney(request.quoteMinor, request.currency)}
          {request.quoteNote ? ` · ${request.quoteNote}` : ''}
          {request.paidAt ? ` · paid ${compactRelative(request.paidAt)}` : ''}
        </p>
      )}

      {canQuote && (
        <div className="mt-3 grid gap-2 border-t border-[var(--fs-rule)] pt-3 sm:grid-cols-[140px_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <Label htmlFor={`quote-amount-${request.id}`}>
              Quote ({request.currency.toUpperCase()})
            </Label>
            <Input
              id={`quote-amount-${request.id}`}
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor={`quote-note-${request.id}`}>
              What the client will read
            </Label>
            <Textarea
              id={`quote-note-${request.id}`}
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Includes a new workshops page with its own booking calendar; live within 5 working days of payment."
              className="mt-1"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onQuote} disabled={busy}>
              <BadgeEuro className="h-4 w-4" />
              {request.status === 'quoted' ? 'Re-quote' : 'Send quote'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onStatus('declined')}
              disabled={busy}
            >
              <XCircle className="h-4 w-4" />
              Decline
            </Button>
          </div>
        </div>
      )}

      {request.status === 'done' && (
        <p className="mt-2 text-xs text-[var(--fs-ink-dim)]">
          {request.completedVia === 'build' && request.builtVersion !== null
            ? `Built and published in version ${request.builtVersion}.`
            : request.completedVia === 'manual'
            ? `Marked done by hand: ${
                request.completionNote ?? 'no reason recorded'
              }`
            : 'Done.'}
        </p>
      )}

      {request.status === 'paid' && (
        <div
          data-testid="change-request-build"
          className="mt-3 space-y-2 border-t border-[var(--fs-rule)] pt-3"
        >
          {canBuild ? (
            <>
              <Label htmlFor={`build-note-${request.id}`}>
                Anything the agents should know (optional)
              </Label>
              <Textarea
                id={`build-note-${request.id}`}
                rows={2}
                value={buildNote}
                onChange={(e) => setBuildNote(e.target.value)}
                placeholder="Put the gallery under the case study body, three across on desktop."
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  data-testid="change-request-build-start"
                  onClick={onBuild}
                  disabled={busy}
                >
                  <Hammer className="h-4 w-4" />
                  Build this change
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--fs-ink-faint)]">
              This project has no delivered site to change yet, so the work
              cannot be built. A change is buildable once the site is in human
              QA or live.
            </p>
          )}

          {/* The manual override, deliberately behind a second click and a
              typed reason: it closes the row without shipping anything. */}
          {!override ? (
            <button
              type="button"
              data-testid="change-request-override"
              onClick={() => setOverride(true)}
              className="text-[11px] text-[var(--fs-ink-faint)] underline underline-offset-2"
            >
              Mark done by hand instead
            </button>
          ) : (
            <div className="space-y-2 rounded-lg border border-[var(--fs-rule)] p-2">
              <Label htmlFor={`done-reason-${request.id}`}>
                How was this handled? Stored on the request.
              </Label>
              <Textarea
                id={`done-reason-${request.id}`}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Client changed their mind on a call; nothing to build."
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOverride(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="change-request-done"
                  onClick={() => onStatus('done')}
                  disabled={busy || reason.trim().length < 10}
                >
                  <Check className="h-4 w-4" />
                  Mark done
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {jobId && (
        <BuildConversation
          projectId={projectId}
          jobId={jobId}
          status={request.status === 'done' ? 'succeeded' : 'running'}
        />
      )}
    </li>
  );
}

export function ChangesTab({ project }: { project: Project }) {
  const { data, isLoading, error } = useChangeRequests(project.id);
  const projectState = project.project_state ?? '';

  if (error) {
    return (
      <ShellCard>
        <p className="text-sm text-red-500">
          {error instanceof Error
            ? error.message
            : 'Could not load change requests.'}
        </p>
      </ShellCard>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="h-28 animate-pulse rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)]" />
    );
  }

  const open = data.requests.filter((r) => r.status === 'requested').length;
  return (
    <ShellCard>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--fs-ink-dim)]">
          Change requests
        </h3>
        {open > 0 && (
          <span className="text-xs text-[var(--fs-ink-faint)]">
            {open} waiting for a quote
          </span>
        )}
      </div>
      {data.requests.length === 0 ? (
        <p className="text-xs text-[var(--fs-ink-faint)]">
          Nothing asked for yet. Requests the client files from the
          editor&apos;s &ldquo;Bigger changes&rdquo; tab land here for a quote.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.requests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              projectId={project.id}
              projectState={projectState}
            />
          ))}
        </ul>
      )}
    </ShellCard>
  );
}
