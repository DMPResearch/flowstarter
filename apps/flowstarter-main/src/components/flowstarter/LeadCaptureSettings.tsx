'use client';

import { useState } from 'react';

/**
 * The client's own view of the token their contact form posts with.
 *
 * Three things on screen and no more: the token, the snippet somebody would
 * paste if their form lives somewhere we did not build, and Rotate.
 *
 * Rotate asks first, and the question says what it costs, because it is the
 * one action here that breaks something that currently works: the site keeps
 * sending the old token until it is rebuilt, and the endpoint refuses it from
 * the moment the new one exists. A confirm dialog that only said "are you
 * sure" would be asking about the wrong thing.
 */
export function LeadCaptureSettings({
  workspaceId,
  initialToken,
  endpoint,
}: {
  workspaceId: string;
  initialToken: string;
  /** The full POST URL for `initialToken`, built on the server. */
  endpoint: string;
}) {
  const [token, setToken] = useState(initialToken);
  const [url, setUrl] = useState(endpoint);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/client/lead-capture/${workspaceId}`, {
        method: 'POST',
      });
      const json = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!res.ok || !json.token) {
        setError(json.error ?? 'Could not rotate your token.');
        return;
      }
      setToken(json.token);
      setUrl(url.replace(/[^/]+$/, json.token));
      setRotated(true);
      setConfirming(false);
    } catch {
      setError('Could not reach the server. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="lead-capture-settings">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-[var(--fs-ink)]">
          Your form token
        </span>
        <code
          data-testid="lead-capture-token"
          className="block break-all rounded-xl border border-[var(--fs-glass-edge)] bg-white/80 px-4 py-3 font-mono text-xs text-[var(--fs-ink)]"
        >
          {token}
        </code>
        <span className="text-xs text-[var(--fs-ink)]/60">
          This is public. It sits in your website&apos;s HTML, and all it can do
          is send one enquiry to this project. It is not a password and it can
          never read anything.
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-[var(--fs-ink)]">
          Where your form posts
        </span>
        <code
          data-testid="lead-capture-endpoint"
          className="block break-all rounded-xl border border-[var(--fs-glass-edge)] bg-white/80 px-4 py-3 font-mono text-xs text-[var(--fs-ink)]"
        >
          {url}
        </code>
        <span className="text-xs text-[var(--fs-ink)]/60">
          The site we built for you already posts here. This is for anyone
          wiring up a form we did not make.
        </span>
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {rotated ? (
        <p
          className="text-sm text-emerald-700"
          data-testid="lead-capture-rotated"
        >
          Done. Your site starts using the new token the next time it is
          published.
        </p>
      ) : null}

      {confirming ? (
        <div
          className="flex flex-col gap-3 rounded-xl border border-[var(--fs-glass-edge)] bg-white/70 px-4 py-4"
          data-testid="lead-capture-confirm"
        >
          <p className="text-sm text-[var(--fs-ink)]">
            Rotating stops the old token working straight away. Your live site
            keeps sending the old one until it is published again, so enquiries
            will not arrive in between. Rotate anyway?
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              data-testid="lead-capture-rotate-confirm"
              onClick={() => void rotate()}
              className="w-fit rounded-xl bg-[var(--purple-primary)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Rotating' : 'Yes, rotate it'}
            </button>
            <button
              type="button"
              disabled={busy}
              data-testid="lead-capture-rotate-cancel"
              onClick={() => setConfirming(false)}
              className="w-fit rounded-xl border border-[var(--fs-glass-edge)] px-5 py-2.5 text-sm font-semibold text-[var(--fs-ink)] disabled:opacity-60"
            >
              Keep this one
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="lead-capture-rotate"
          onClick={() => {
            setRotated(false);
            setConfirming(true);
          }}
          className="w-fit rounded-xl border border-[var(--fs-glass-edge)] px-5 py-2.5 text-sm font-semibold text-[var(--fs-ink)]"
        >
          Rotate
        </button>
      )}
    </div>
  );
}
