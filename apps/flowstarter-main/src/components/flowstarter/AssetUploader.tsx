'use client';

/**
 * The other half of an ask: a way to answer it.
 *
 * Sits under one open request and does two separate things, in this order,
 * because they are two separate statements:
 *
 *  1. Send the files. `POST /api/client/assets/[workspaceId]` verifies the
 *     bytes and stores them. Nothing is usable yet.
 *  2. Confirm the rights. `POST /api/client/assets/[workspaceId]/rights`
 *     records who said what, about which files, when, and from where.
 *
 * Collapsing those into one step — a tick-box beside the file picker, or worse,
 * implied consent on upload — would make the record worthless: it would prove
 * the client clicked "upload", not that they read a sentence about ownership
 * and applied it to specific pictures. So the checkbox appears *after* the
 * thumbnails, next to the images it is about, and the files stay marked "not
 * usable yet" until it is ticked.
 *
 * Progress is real (XHR upload events), not a spinner pretending: a client on
 * a phone sending four photographs over a slow connection deserves to know
 * whether anything is happening.
 *
 * The third thing it does, after the thumbnails are back, is ask what each
 * picture *shows*. Six files that arrived on 2026-09-12 carried no caption at
 * all, so the operator's picker offered six identical lines and the build
 * agent -- rightly forbidden from guessing -- put two screenshots on the wrong
 * case study under an invented caption. A caption the client wrote, or an
 * automatic one they read and confirmed, is the only thing downstream that can
 * tell one 1200x750 PNG from another. `requireCaption` makes that confirmation
 * part of the same gate the rights statement already is, for the uploads where
 * placement depends on it.
 */
import { useCallback, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  CURRENT_RIGHTS_STATEMENT_VERSION,
  rightsStatementText,
} from './rights-statement';

/** One asset as the client API reports it. */
export interface ClientAssetView {
  id: string;
  kind: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usable: boolean;
  url: string | null;
  /** What the picture shows, in the client's words or ours. */
  caption: string | null;
  /** Whose words those are. Null when nothing has been written yet. */
  captionSource: 'client' | 'auto' | null;
  /** What the automatic pass took the picture to be, when it ran. */
  autoCaptionKind: 'screenshot' | 'photo' | 'logo' | 'document' | null;
}

export interface SufficiencySummary {
  ready: boolean;
  missing: Array<{ code?: string; message?: string; severity?: string }>;
}

export interface AssetUploaderProps {
  workspaceId: string;
  /** The ask this uploader answers; recorded on the project event. */
  askKey?: string;
  /** Slot hint (`hero`, `logo`, `section`) so `usable_for` can be set. */
  slot?: string | null;
  /** Human label for the control, e.g. "Add photos". */
  label?: string;
  /**
   * Fired after any successful write, with the server's recomputed readiness
   * and the exact asset ids this write just touched — the ids just uploaded,
   * or the ids rights were just confirmed over.
   *
   * The second argument exists so a caller never has to guess which files are
   * new by diffing a global asset list against what it already knew: that
   * diff is only correct if nothing else on the page reads the same list
   * between the write and the diff, and a brief with several uploaders on one
   * page routinely breaks that assumption. An asset a client attached,
   * captioned and confirmed the rights to was once silently missing from the
   * project it belonged to because two uploaders' own refreshes of the shared
   * list landed out of order; passing the ids this call itself just wrote
   * removes the race by construction.
   */
  onSufficiency?: (
    sufficiency: SufficiencySummary | null,
    assetIds: string[]
  ) => void;
  /**
   * Whether a caption is part of what "confirmed" means here. True on the
   * uploads whose placement is decided by what the picture shows -- a project
   * screenshot has to say which project it belongs to, and nothing else in
   * the request carries that. False everywhere else: a photograph of a
   * workshop is still a photograph of a workshop with nothing typed under it.
   */
  requireCaption?: boolean;
  /** The sentence shown while a required caption is still outstanding. */
  captionPrompt?: string;
  className?: string;
}

type Phase = 'idle' | 'uploading' | 'uploaded' | 'confirming' | 'confirmed';

interface UploadResponse {
  uploaded?: Array<{ id: string }>;
  assets?: ClientAssetView[];
  sufficiency?: SufficiencySummary | null;
  error?: string;
}

/**
 * `fetch` cannot report upload progress, so this uses XHR. Resolves with the
 * parsed body and the status; never rejects for an HTTP error, only for a
 * transport failure.
 */
function postWithProgress(
  url: string,
  body: FormData,
  onProgress: (percent: number) => void
): Promise<{ status: number; payload: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener('load', () => {
      let payload: UploadResponse = {};
      try {
        payload = JSON.parse(request.responseText) as UploadResponse;
      } catch {
        /* A body we cannot parse is a body we ignore; status still decides. */
      }
      resolve({ status: request.status, payload });
    });
    request.addEventListener('error', () => reject(new Error('Upload failed')));
    request.addEventListener('abort', () =>
      reject(new Error('Upload cancelled'))
    );
    request.send(body);
  });
}

export function AssetUploader({
  workspaceId,
  askKey,
  slot = null,
  label = 'Add photos',
  onSufficiency,
  requireCaption = false,
  captionPrompt = 'Say what each picture shows, so we put it in the right place.',
  className,
}: AssetUploaderProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<ClientAssetView[]>([]);
  const [agreed, setAgreed] = useState(false);
  // What is in the caption boxes right now, keyed by asset. Held apart from
  // `uploaded` so an automatic caption being edited is still distinguishable
  // from one that was saved: only the save moves the source to 'client'.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingCaption, setSavingCaption] = useState<string | null>(null);

  const endpoint = `/api/client/assets/${workspaceId}`;
  const statement = rightsStatementText();

  const send = useCallback(
    async (files: FileList) => {
      if (files.length === 0) return;
      setPhase('uploading');
      setPercent(0);
      setError(null);

      const form = new FormData();
      for (let index = 0; index < files.length; index += 1) {
        const file = files.item(index);
        if (file) form.append('files', file);
      }
      if (slot) form.append('slot', slot);
      if (askKey) form.append('askKey', askKey);

      try {
        const { status, payload } = await postWithProgress(
          endpoint,
          form,
          setPercent
        );
        if (status < 200 || status >= 300) {
          setError(payload.error ?? 'That upload did not go through.');
          setPhase('idle');
          return;
        }
        const ids = new Set((payload.uploaded ?? []).map((item) => item.id));
        const justSent = (payload.assets ?? []).filter((asset) =>
          ids.has(asset.id)
        );
        setUploaded(justSent);
        setPhase(
          justSent.every((asset) => asset.usable) ? 'confirmed' : 'uploaded'
        );
        onSufficiency?.(
          payload.sufficiency ?? null,
          justSent.map((asset) => asset.id)
        );
      } catch {
        setError('That upload did not go through. Please try again.');
        setPhase('idle');
      } finally {
        // Let the same file be chosen again after a failure.
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [askKey, endpoint, onSufficiency, slot]
  );

  const confirmRights = useCallback(async () => {
    const pending = uploaded.filter((asset) => !asset.usable);
    if (!agreed || pending.length === 0) return;
    setPhase('confirming');
    setError(null);
    try {
      const response = await fetch(`${endpoint}/rights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetIds: pending.map((asset) => asset.id),
          statementVersion: CURRENT_RIGHTS_STATEMENT_VERSION,
        }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as UploadResponse & {
        confirmedAssetIds?: string[];
      };
      if (!response.ok) {
        setError(payload.error ?? 'We could not record that confirmation.');
        setPhase('uploaded');
        return;
      }
      const confirmed = new Set(payload.confirmedAssetIds ?? []);
      setUploaded((current) =>
        current.map((asset) =>
          confirmed.has(asset.id) ? { ...asset, usable: true } : asset
        )
      );
      setPhase('confirmed');
      onSufficiency?.(payload.sufficiency ?? null, Array.from(confirmed));
    } catch {
      setError('We could not record that confirmation. Please try again.');
      setPhase('uploaded');
    }
  }, [agreed, endpoint, onSufficiency, uploaded]);

  /**
   * Writes one caption. Re-sending an automatic caption unchanged is not a
   * no-op: the route sets the source to 'client' either way, and that is the
   * whole record that a person read the sentence and stood behind it.
   */
  const saveCaption = useCallback(
    async (assetId: string, caption: string) => {
      const text = caption.trim();
      if (text.length === 0) return;
      setSavingCaption(assetId);
      setError(null);
      try {
        const response = await fetch(`${endpoint}/caption`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId, caption: text }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          asset?: { id: string; caption: string; captionSource: 'client' };
          error?: string;
        };
        if (!response.ok || !payload.asset) {
          setError(payload.error ?? 'We could not save that caption.');
          return;
        }
        const saved = payload.asset;
        // The stored text wins over what is in the box, the way the brief
        // form takes the server's answer back after a save.
        setUploaded((current) =>
          current.map((asset) =>
            asset.id === saved.id
              ? {
                  ...asset,
                  caption: saved.caption,
                  captionSource: saved.captionSource,
                }
              : asset
          )
        );
        setDrafts((current) => ({ ...current, [saved.id]: saved.caption }));
      } catch {
        setError('We could not save that caption. Please try again.');
      } finally {
        setSavingCaption(null);
      }
    },
    [endpoint]
  );

  const busy = phase === 'uploading' || phase === 'confirming';
  const needsRights = uploaded.some((asset) => !asset.usable);
  const captionsOutstanding =
    requireCaption &&
    uploaded.some((asset) => asset.captionSource !== 'client');

  return (
    <div
      className={cn('flex flex-col gap-3', className)}
      data-testid="asset-uploader"
      data-require-caption={requireCaption ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={inputId}
          className={cn(
            'inline-flex cursor-pointer items-center rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)] px-4 py-2 text-xs font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40',
            busy && 'pointer-events-none opacity-60'
          )}
        >
          {phase === 'uploading' ? 'Sending…' : label}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          className="sr-only"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          disabled={busy}
          onChange={(event) => {
            const files = event.target.files;
            if (files) void send(files);
          }}
        />
        <span className="text-xs text-[var(--fs-ink-faint)]">
          JPEG, PNG, GIF or WebP · up to 8MB each
        </span>
      </div>

      {phase === 'uploading' ? (
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Upload progress"
          className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--fs-rule)]"
        >
          <div
            className="h-full rounded-full bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="asset-uploader-error"
          className="text-xs font-medium text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}

      {uploaded.length > 0 ? (
        <ul className="flex flex-wrap gap-3" aria-label="Files you sent">
          {uploaded.map((asset) => {
            const draft = drafts[asset.id] ?? asset.caption ?? '';
            return (
              <li key={asset.id} className="flex w-44 flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived URL on a private bucket cannot be optimised by next/image */}
                <img
                  src={asset.url ?? ''}
                  alt="Uploaded file"
                  data-testid="asset-thumbnail"
                  data-usable={asset.usable ? 'true' : 'false'}
                  className={cn(
                    'h-16 w-16 rounded-xl border border-[var(--fs-rule)] object-cover',
                    !asset.usable && 'opacity-60'
                  )}
                />
                <input
                  type="text"
                  value={draft}
                  aria-label="What this picture shows"
                  placeholder="What this picture shows"
                  disabled={savingCaption === asset.id}
                  data-testid={`asset-caption-input-${asset.id}`}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [asset.id]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-[var(--fs-rule)] bg-transparent px-2 py-1 text-[11px] text-[var(--fs-ink)] outline-none focus:border-[var(--purple-primary)]"
                />
                {asset.captionSource ? (
                  <span
                    data-testid={`asset-caption-source-${asset.id}`}
                    className="text-[11px] leading-snug text-[var(--fs-ink-faint)]"
                  >
                    {asset.captionSource === 'auto'
                      ? 'We had a guess at this. Check it is right.'
                      : 'You confirmed this.'}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={
                    savingCaption === asset.id || draft.trim().length === 0
                  }
                  onClick={() => void saveCaption(asset.id, draft)}
                  data-testid={`asset-caption-save-${asset.id}`}
                  className="w-fit rounded-lg border border-[var(--fs-rule)] px-2 py-1 text-[11px] font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40 disabled:pointer-events-none disabled:opacity-40"
                >
                  {savingCaption === asset.id ? 'Saving…' : 'Save caption'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {captionsOutstanding ? (
        <p
          data-testid="asset-caption-required-hint"
          className="text-[11px] leading-relaxed text-[var(--fs-ink-dim)]"
        >
          {captionPrompt}
        </p>
      ) : null}

      {needsRights ? (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3 py-3">
          <label className="flex items-start gap-2 text-xs leading-relaxed text-[var(--fs-ink)]">
            <input
              type="checkbox"
              checked={agreed}
              disabled={busy}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded border-[var(--fs-rule)] accent-[var(--purple-primary)]"
              data-testid="rights-checkbox"
            />
            <span>{statement}</span>
          </label>
          <button
            type="button"
            disabled={!agreed || busy || captionsOutstanding}
            onClick={() => void confirmRights()}
            data-testid="confirm-rights"
            className="w-fit rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-4 py-2 text-xs font-semibold text-white shadow-md shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[linear-gradient(135deg,var(--landing-btn-hover-from),var(--landing-btn-hover-via))] active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
          >
            {phase === 'confirming' ? 'Saving…' : 'Confirm and use these'}
          </button>
          <p className="text-[11px] text-[var(--fs-ink-faint)]">
            We won&apos;t put anything on your site until you confirm this.
            {captionsOutstanding
              ? ' Save a caption on each picture first, so it lands where you meant it to.'
              : ''}
          </p>
        </div>
      ) : null}

      {phase === 'confirmed' && uploaded.length > 0 ? (
        <p
          data-testid="asset-uploader-done"
          className="text-xs font-medium text-emerald-700 dark:text-emerald-400"
        >
          Thanks, {uploaded.length === 1 ? 'that file is' : 'those files are'}{' '}
          with us and cleared for use.
        </p>
      ) : null}
    </div>
  );
}

export default AssetUploader;
