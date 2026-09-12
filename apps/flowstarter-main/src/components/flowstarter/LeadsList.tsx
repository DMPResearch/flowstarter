'use client';

import { useState } from 'react';
import type { WorkspaceLead } from '@/lib/flowstarter/lead-capture';

/**
 * The client's enquiries, newest first, with spam behind a toggle.
 *
 * Presentation only: the rows arrive already ordered and already filtered by
 * `listWorkspaceLeads`, which is where "newest first" and "not spam" are
 * decided. The toggle re-renders from a list the page loaded once, because a
 * client flicking spam on and off should not cost a round trip.
 *
 * Spam is shown muted rather than left out entirely. The classifier is a pair
 * of regular expressions and it will be wrong about somebody's real customer
 * eventually; a client who can see the pile can find them.
 */
export function LeadsList({
  leads,
  spam,
}: {
  leads: readonly WorkspaceLead[];
  spam: readonly WorkspaceLead[];
}) {
  const [showSpam, setShowSpam] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      {leads.length === 0 ? (
        <p
          className="rounded-2xl border border-[var(--fs-glass-edge)] bg-white/60 px-5 py-6 text-sm text-[var(--fs-ink)]/70"
          data-testid="leads-empty"
        >
          No enquiries yet. When somebody fills in the contact form on your
          site, their message shows up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="leads-list">
          {leads.map((lead) => (
            <LeadRow key={lead.id} lead={lead} />
          ))}
        </ul>
      )}

      {spam.length > 0 ? (
        <section className="flex flex-col gap-3">
          <button
            type="button"
            data-testid="leads-spam-toggle"
            onClick={() => setShowSpam((value) => !value)}
            className="w-fit text-sm font-semibold text-[var(--purple-primary)] underline underline-offset-4"
          >
            {showSpam
              ? 'Hide filtered messages'
              : `Show ${spam.length} filtered as spam`}
          </button>
          {showSpam ? (
            <ul
              className="flex flex-col gap-3 opacity-60"
              data-testid="leads-spam"
            >
              {spam.map((lead) => (
                <LeadRow key={lead.id} lead={lead} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function LeadRow({ lead }: { lead: WorkspaceLead }) {
  return (
    <li className="flex flex-col gap-1 rounded-2xl border border-[var(--fs-glass-edge)] bg-white/70 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-[var(--fs-ink)]">
          {lead.name ?? 'Someone'}
        </span>
        <span className="text-xs text-[var(--fs-ink)]/50">
          {formatLeadDate(lead.createdAt)}
        </span>
      </div>
      {lead.message ? (
        <p className="whitespace-pre-line text-sm text-[var(--fs-ink)]/80">
          {lead.message}
        </p>
      ) : null}
      <p className="text-xs text-[var(--fs-ink)]/60">
        {[lead.email, lead.phone, lead.source].filter(Boolean).join(' · ')}
      </p>
    </li>
  );
}

/**
 * A date somebody can act on rather than an ISO string. Not relative: "2 days
 * ago" is harder to quote back to a customer than a date.
 */
export function formatLeadDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
