'use client';

/**
 * The client's own change requests under the "Bigger changes" box: what they
 * asked for, whether the team has priced it, and the two buttons a quote
 * needs. Accepting a priced quote goes to Stripe Checkout and comes back to
 * this page; the request reads "paid" once the webhook has heard from Stripe.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChangeRequestView } from '@/lib/flowstarter/change-requests';
import {
  EditorRequestError,
  editorApiBase,
  requestEditor,
} from './editor-client';

const STATUS_COPY: Record<ChangeRequestView['status'], string> = {
  requested: 'With your team for a quote',
  quoted: 'Quoted',
  accepted: 'Accepted, finish the payment to start the work',
  paid: 'Paid, your team is on it',
  done: 'Done',
  declined: 'Declined',
};

/**
 * What a paid request says while the work is actually happening, and after.
 *
 * A paid request used to read "your team is on it" forever, because there was
 * no work for the team to do it with: the operator's only button moved a
 * status. Now a paid request with a build attached says so, and a finished one
 * names the version it went live in, which is the same number the client's own
 * version history shows them.
 */
export function changeRequestProgress(request: ChangeRequestView): string {
  if (request.status === 'done') {
    return request.builtVersion !== null
      ? `Done, live in version ${request.builtVersion}`
      : 'Done';
  }
  if (request.status === 'paid' && request.buildJobId) {
    return 'In progress, we are making the change now';
  }
  return STATUS_COPY[request.status];
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}

export function ChangeRequestsList({
  workspaceId,
  refreshSignal,
}: {
  workspaceId: string;
  /** Bump after filing a new request so the list picks it up. */
  refreshSignal: number;
}) {
  const [requests, setRequests] = useState<ChangeRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await requestEditor<{ requests: ChangeRequestView[] }>(
        `${editorApiBase(workspaceId)}/changes`,
        { method: 'GET' }
      );
      setRequests(data.requests);
      setError(null);
    } catch (e) {
      setError(
        e instanceof EditorRequestError
          ? e.message
          : 'Could not load your requests.'
      );
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const respond = async (id: string, decision: 'accept' | 'decline') => {
    setBusyId(id);
    try {
      const result = await requestEditor<{
        checkoutUrl?: string;
        request?: ChangeRequestView;
      }>(`${editorApiBase(workspaceId)}/changes/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      await load();
    } catch (e) {
      setError(
        e instanceof EditorRequestError ? e.message : 'That did not go through.'
      );
    } finally {
      setBusyId(null);
    }
  };

  if (requests === null && !error) return null;
  if (requests && requests.length === 0 && !error) return null;

  return (
    <div data-testid="change-requests-list" className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--fs-ink-faint)]">
        Your requests
      </p>
      {error && (
        <p className="rounded-xl border border-red-600/25 bg-red-600/10 px-3 py-2 text-sm text-red-800 dark:text-red-300">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {(requests ?? []).map((request) => (
          <li
            key={request.id}
            data-testid="change-request-item"
            data-status={request.status}
            className="rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3.5 py-3"
          >
            <p className="text-sm text-[var(--fs-ink)]">{request.request}</p>
            <p
              data-testid="change-request-progress"
              className="mt-1 text-xs text-[var(--fs-ink-dim)]"
            >
              {changeRequestProgress(request)}
              {request.quoteMinor !== null &&
                request.status !== 'requested' &&
                ` · ${formatMoney(request.quoteMinor, request.currency)}`}
            </p>
            {request.quoteNote && request.status !== 'requested' && (
              <p className="mt-1 text-xs italic text-[var(--fs-ink-dim)]">
                {request.quoteNote}
              </p>
            )}
            {(request.status === 'quoted' || request.status === 'accepted') && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="change-request-accept"
                  disabled={busyId === request.id}
                  onClick={() => void respond(request.id, 'accept')}
                  className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:pointer-events-none"
                >
                  {request.quoteMinor
                    ? `Accept and pay ${formatMoney(
                        request.quoteMinor,
                        request.currency
                      )}`
                    : 'Accept'}
                </button>
                {request.status === 'quoted' && (
                  <button
                    type="button"
                    data-testid="change-request-decline"
                    disabled={busyId === request.id}
                    onClick={() => void respond(request.id, 'decline')}
                    className="rounded-lg border border-[var(--fs-rule)] px-3 py-1.5 text-sm font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:opacity-60"
                  >
                    No thanks
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
