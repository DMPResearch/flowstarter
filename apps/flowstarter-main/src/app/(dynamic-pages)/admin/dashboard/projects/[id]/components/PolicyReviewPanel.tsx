'use client';

/**
 * The operator board's view of the acceptable-use gate.
 *
 * A row here means a submission was held or refused by the policy gate in
 * `@/lib/policy`. `review` rows are open and waiting on a person; `refuse`
 * rows were closed by the gate itself and are shown for the record. Approving
 * an open row lifts the hold and, for a held brief, starts the build the save
 * never got to start.
 *
 * Renders nothing at all on a clean project: no reviews means no panel, so
 * the pipeline tab looks exactly as it did before this gate existed.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ShieldAlert, XCircle } from 'lucide-react';
import { ShellCard } from '../../../components/TeamDashboardShell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { compactRelative } from '@/lib/format-utils';

/**
 * The shapes below mirror `PolicyReviewView` in `@/lib/policy/review-api`.
 * They are redeclared rather than imported: that module (and the row type it
 * builds on) is marked `server-only`, and a client component must not pull it
 * into its bundle even by a type that gets erased at build time.
 */
type PolicyReviewStatus = 'open' | 'approved' | 'refused';

interface PolicyReviewView {
  id: string;
  workspaceId: string | null;
  surface: string;
  decision: 'review' | 'refuse';
  categoryId: string;
  confidence: number;
  rule: string;
  tier: string;
  promptVersion: string;
  evidenceHash: string;
  evidence: string;
  status: PolicyReviewStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  categoryLabel: string;
  categoryReason: string;
  disposition: string;
}

interface PolicyDecisionResponse {
  review: PolicyReviewView;
  build?: { outcome: string; jobId: string | null };
}

const MIN_APPROVAL_NOTE_CHARS = 10;

const STATUS_TONE: Record<PolicyReviewStatus, string> = {
  open: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  approved:
    'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  refused: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
};
const STATUS_LABEL: Record<PolicyReviewStatus, string> = {
  open: 'Open, waiting on an operator',
  approved: 'Approved',
  refused: 'Refused',
};

const SURFACE_LABEL: Record<string, string> = {
  preview: 'Preview',
  claim: 'Claim',
  guest_deposit: 'Guest deposit',
  brief: 'Brief',
  change_request: 'Change request',
  operator_quote: 'Operator quote',
  built_site: 'Built site',
};

const BUILD_OUTCOME_LABEL: Record<string, string> = {
  enqueued: 'Build queued.',
  resumed: 'Build resumed.',
  already_building: 'A build is already running for this project.',
  skipped: 'No build was started; the brief is not ready yet.',
};

function humanize(token: string): string {
  return token.replace(/_/g, ' ');
}

function readableError(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

async function readErrorBody(
  res: Response
): Promise<{ error?: string; code?: string } | null> {
  return res.json().catch(() => null);
}

function PolicyReviewCard({
  review,
  projectId,
  onResolved,
}: {
  review: PolicyReviewView;
  projectId: string;
  onResolved: (updated: PolicyReviewView) => void;
}) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<'approve' | 'refuse' | null>(
    null
  );
  const busy = submitting !== null;
  const noteTooShort = note.trim().length < MIN_APPROVAL_NOTE_CHARS;

  const onDecision = async (decision: 'approve' | 'refuse') => {
    if (decision === 'approve' && noteTooShort) return;
    setSubmitting(decision);
    try {
      const res = await fetch(
        `/api/admin/projects/${projectId}/policy/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewId: review.id, decision, note }),
        }
      );
      if (!res.ok) {
        const body = await readErrorBody(res);
        if (res.status === 409 || body?.code === 'POLICY_REVIEW_STALE') {
          toast.error(
            'That review is not open any more. Reload the board and look again.'
          );
        } else {
          toast.error(body?.error || 'Could not record that decision.');
        }
        return;
      }
      const data = (await res.json()) as PolicyDecisionResponse;
      onResolved(data.review);
      setNote('');
      const verdictLine = decision === 'approve' ? 'Approved.' : 'Refused.';
      const buildLine = data.build
        ? ` ${
            BUILD_OUTCOME_LABEL[data.build.outcome] ?? 'Build state updated.'
          }`
        : '';
      toast.success(`${verdictLine}${buildLine}`);
    } catch (e) {
      toast.error(readableError(e, 'Could not record that decision.'));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <li
      // Matched by `reviewBoardUrl` in `@/lib/policy/review`, which is what
      // the "A brief needs your review" operator email's button and primary
      // link point at.
      id={`policy-review-${review.id}`}
      data-testid="policy-review-card"
      data-review-id={review.id}
      className="rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)] p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--fs-ink)]">
            {review.categoryLabel}
          </p>
          <p className="mt-1 text-[11px] text-[var(--fs-ink-faint)]">
            {SURFACE_LABEL[review.surface] ?? humanize(review.surface)} ·{' '}
            {compactRelative(review.createdAt)} · disposition{' '}
            {humanize(review.disposition)} · confidence{' '}
            {Math.round(review.confidence * 100)}%
          </p>
          <p className="mt-1 text-[11px] text-[var(--fs-ink-faint)]">
            Rule {humanize(review.rule)} · tier {humanize(review.tier)} · prompt{' '}
            {review.promptVersion}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5 ${
            STATUS_TONE[review.status]
          }`}
        >
          {STATUS_LABEL[review.status]}
        </span>
      </div>

      {review.evidence && (
        <p className="mt-2 line-clamp-2 text-[11px] italic leading-snug text-[var(--fs-ink-dim)]">
          “{review.evidence}”
        </p>
      )}
      <p className="mt-1 text-[11px] text-[var(--fs-ink-faint)]">
        Evidence hash <span className="font-mono">{review.evidenceHash}</span>
      </p>

      {review.status === 'open' ? (
        <div className="mt-3 space-y-2 border-t border-[var(--fs-rule)] pt-3">
          <Label htmlFor={`policy-note-${review.id}`}>What did you check</Label>
          <Textarea
            id={`policy-note-${review.id}`}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Licence number checked, called the client, the jurisdiction is fine."
          />
          {noteTooShort && (
            <p className="text-[11px] text-[var(--fs-ink-faint)]">
              Say what you checked before approving. A licence number, a call,
              the jurisdiction. At least {MIN_APPROVAL_NOTE_CHARS}
              characters.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDecision('refuse')}
              disabled={busy}
            >
              <XCircle className="h-4 w-4" />
              Refuse
            </Button>
            <Button
              size="sm"
              onClick={() => onDecision('approve')}
              disabled={busy || noteTooShort}
            >
              <Check className="h-4 w-4" />
              Approve
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--fs-ink-dim)]">
          {STATUS_LABEL[review.status]} by {review.resolvedBy ?? 'unknown'}
          {review.resolvedAt ? ` · ${compactRelative(review.resolvedAt)}` : ''}
          {review.resolutionNote ? ` · ${review.resolutionNote}` : ''}
        </p>
      )}
    </li>
  );
}

export function PolicyReviewPanel({ projectId }: { projectId: string }) {
  const [reviews, setReviews] = useState<PolicyReviewView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/admin/projects/${projectId}/policy`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = await readErrorBody(res);
          throw new Error(body?.error || 'Could not load the policy queue.');
        }
        const data = (await res.json()) as {
          reviews: PolicyReviewView[];
          openCount: number;
        };
        if (!cancelled) setReviews(data.reviews);
      } catch (e) {
        if (!cancelled) {
          setLoadError(readableError(e, 'Could not load the policy queue.'));
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const onResolved = (updated: PolicyReviewView) => {
    setReviews((current) =>
      current
        ? current.map((review) => (review.id === updated.id ? updated : review))
        : current
    );
  };

  if (loadError) {
    return (
      <ShellCard>
        <p className="text-sm text-red-500">{loadError}</p>
      </ShellCard>
    );
  }
  if (!reviews || reviews.length === 0) return null;

  const openCount = reviews.filter((review) => review.status === 'open').length;

  return (
    <ShellCard>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--fs-ink-dim)]">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          Acceptable use
        </h3>
        {openCount > 0 && (
          <span className="text-xs text-[var(--fs-ink-faint)]">
            {openCount} waiting on an operator
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {reviews.map((review) => (
          <PolicyReviewCard
            key={review.id}
            review={review}
            projectId={projectId}
            onResolved={onResolved}
          />
        ))}
      </ul>
    </ShellCard>
  );
}
