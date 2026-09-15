'use client';

/**
 * Every version of the site, and the two things you can do with one: go back
 * to it, or put the current one live.
 *
 * The publish button reports what the server actually did rather than a
 * green tick. On an environment with no deploy agent that is "nothing was
 * pushed (dry run)"; on a project with no build of the edited files yet it is
 * "we rebuild it for you". Both are true, and both are better than a client
 * refreshing their live site for ten minutes waiting for a change that was
 * never sent anywhere.
 */
import { useState } from 'react';
import { siteVersionAuthor } from '@/lib/flowstarter/site-version-author';
import { PolicyNotice } from './PolicyNotice';
import {
  EditorRequestError,
  requestEditor,
  type EditorVersion,
  type PolicyDecision,
} from './editor-client';

export function VersionHistoryPanel({
  base,
  versions,
  currentVersion,
  viewerId = null,
  policy,
  onChanged,
}: {
  base: string;
  versions: EditorVersion[];
  currentVersion: number;
  /** Whoever is looking, so their own change reads "You" instead of an id. */
  viewerId?: string | null;
  policy: PolicyDecision;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const allowed = policy.action === 'inline_content_agent';

  async function revert(version: number) {
    setBusy(true);
    setError(null);
    try {
      await requestEditor(`${base}/revert`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      await onChanged();
    } catch (caught) {
      setError(
        caught instanceof EditorRequestError
          ? caught.message
          : 'That version could not be restored.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestEditor<{
        version: number;
        deploy: { mode: string; detail: string };
      }>(`${base}/publish`, { method: 'POST' });
      setPublishNote(result.deploy.detail);
      await onChanged();
    } catch (caught) {
      setError(
        caught instanceof EditorRequestError
          ? caught.message
          : 'That could not be published.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-4 py-4 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
      <PolicyNotice decision={policy} />

      <button
        type="button"
        data-testid="editor-publish"
        onClick={publish}
        disabled={!allowed || busy}
        className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:bg-[linear-gradient(135deg,var(--landing-btn-hover-from),var(--landing-btn-hover-via))] hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:pointer-events-none"
      >
        Put this live
      </button>
      {publishNote ? (
        <p
          data-testid="editor-publish-note"
          className="rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3 py-2 text-sm text-[var(--fs-ink-dim)]"
        >
          {publishNote}
        </p>
      ) : null}

      {versions.length === 0 ? (
        <p className="text-sm text-[var(--fs-ink-dim)]">
          You have not changed anything yet.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {versions.map((entry) => (
          <li
            key={entry.version}
            data-testid="editor-version"
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--fs-ink)]">
                v{entry.version}
                {entry.version === currentVersion ? ' · current' : ''}
                {entry.publishedAt ? ' · live' : ''}
              </p>
              <p className="truncate text-xs text-[var(--fs-ink-faint)]">
                {entry.summary ?? 'Change'} ·{' '}
                {new Date(entry.createdAt).toLocaleDateString()}
              </p>
              {/*
                Who made this, in words. A client whose site changed overnight
                because we built the page they asked for on a call should be
                told that here, on the screen they already look at, rather than
                having to ask whether something went wrong. The rule lives in
                `site-version-author.ts`; this only prints its answer.
              */}
              {(() => {
                const author = siteVersionAuthor(entry.createdBy, viewerId);
                if (!author.label) return null;
                return (
                  <p
                    data-testid="editor-version-author"
                    data-author-kind={author.kind}
                    className="truncate text-xs font-medium text-[var(--fs-ink-dim)]"
                  >
                    {author.label}
                    {author.kind === 'flowstarter-team'
                      ? ` · version ${entry.version}`
                      : ''}
                  </p>
                );
              })()}
            </div>
            {entry.version === currentVersion ? null : (
              <button
                type="button"
                data-testid="editor-revert"
                onClick={() => revert(entry.version)}
                disabled={!allowed || busy}
                className="shrink-0 rounded-lg border border-[var(--fs-rule)] px-3 py-1.5 text-xs font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:opacity-60 disabled:pointer-events-none"
              >
                Go back to this
              </button>
            )}
          </li>
        ))}
      </ul>

      {error ? (
        <p
          data-testid="history-error"
          className="rounded-xl border border-red-600/25 bg-red-600/10 px-3 py-2 text-sm text-red-800 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
