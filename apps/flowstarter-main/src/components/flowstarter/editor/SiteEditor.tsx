'use client';

/**
 * The client's own editor: their site on the left, one change at a time on the
 * right.
 *
 * SELECTION. The frame is served from `/api/client/site/[id]/preview`, which
 * stamps every editable block with `data-flowstarter-id` and injects a small
 * bridge script. Clicking a block posts its id out; this component matches it
 * against the target list the server sent. The frame is sandboxed into an
 * opaque origin, so a message is trusted by `event.source` — the one thing an
 * opaque origin cannot forge — rather than by `event.origin`, which would be
 * the string "null" for every frame on the internet.
 *
 * NOTHING APPLIES ITSELF. `/edit` returns a proposal; the client reads the old
 * text beside the new one and either applies it or throws it away. A model
 * writing directly into someone's live site, with no step where a person says
 * yes, is not an editor.
 *
 * REFUSALS ARE SHOWN. Every control the policy denies stays visible with the
 * policy's reason next to it. See PolicyNotice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  editCreditsLine,
  type EditCreditPosition,
} from '@/lib/flowstarter/edit-credits';
import { PolicyNotice } from './PolicyNotice';
import { EscalationPanel } from './EscalationPanel';
import { ImageSlotsPanel } from './ImageSlotsPanel';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import {
  EditorRequestError,
  diffWords,
  editorApiBase,
  requestEditor,
  type EditorState,
  type EditorTarget,
  type EditorVersion,
} from './editor-client';

// Repeated rather than imported: the other end of this bridge lives in
// `lib/flowstarter/site-preview.ts`, which is `server-only` and must not be
// pulled into a client bundle. The two constants are asserted together by the
// preview route's test, which checks the served document against these names.
const PREVIEW_MESSAGE_SOURCE = 'flowstarter-site-preview';
const EDITOR_MESSAGE_SOURCE = 'flowstarter-site-editor';

type Tab = 'text' | 'images' | 'request' | 'history';

interface Proposal {
  targetId: string;
  originalContent: string;
  replacementContent: string;
}

export function SiteEditor({
  workspaceId,
  initial,
}: {
  workspaceId: string;
  initial: EditorState;
}) {
  const base = editorApiBase(workspaceId);
  const frame = useRef<HTMLIFrameElement | null>(null);

  const [tab, setTab] = useState<Tab>('text');
  const [targets, setTargets] = useState<EditorTarget[]>(initial.targets);
  const [versions, setVersions] = useState<EditorVersion[]>(initial.versions);
  const [version, setVersion] = useState(initial.site.version);
  const [used, setUsed] = useState(initial.allowance.used);
  const [credits, setCredits] = useState<EditCreditPosition>(
    initial.allowance.credits
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.targets[0]?.id ?? null
  );
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState<'edit' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const contentPolicy = initial.policy.content;
  const canEdit = contentPolicy.action === 'inline_content_agent';
  const selected = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? null,
    [targets, selectedId]
  );

  // The frame is sandboxed, so its origin is opaque and `event.origin` is the
  // useless string "null" for every such frame. Identity comes from the window
  // handle we created instead.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as {
        source?: string;
        type?: string;
        targetId?: string;
      };
      if (data?.source !== PREVIEW_MESSAGE_SOURCE) return;
      if (data.type === 'select' && typeof data.targetId === 'string') {
        setSelectedId(data.targetId);
        setProposal(null);
        setError(null);
        setTab('text');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Selecting from the list highlights the same block in the frame, so the two
  // halves never disagree about what "this" means.
  useEffect(() => {
    if (!selectedId) return;
    frame.current?.contentWindow?.postMessage(
      { source: EDITOR_MESSAGE_SOURCE, type: 'select', targetId: selectedId },
      '*'
    );
  }, [selectedId]);

  const refreshState = useCallback(async () => {
    const state = await requestEditor<EditorState>(base);
    setTargets(state.targets);
    setVersions(state.versions);
    setVersion(state.site.version);
    setUsed(state.allowance.used);
    setCredits(state.allowance.credits);
  }, [base]);

  async function propose() {
    if (!selected || !instruction.trim()) return;
    setBusy('edit');
    setError(null);
    setNotice(null);
    try {
      const result = await requestEditor<
        Proposal & {
          allowance: { used: number; credits: EditCreditPosition };
        }
      >(`${base}/edit`, {
        method: 'POST',
        body: JSON.stringify({
          targetId: selected.id,
          instruction: instruction.trim(),
        }),
      });
      setProposal({
        targetId: result.targetId,
        originalContent: result.originalContent,
        replacementContent: result.replacementContent,
      });
      setUsed(result.allowance.used);
      setCredits(result.allowance.credits);
    } catch (caught) {
      setError(
        caught instanceof EditorRequestError
          ? caught.message
          : 'That did not work. Please try again.'
      );
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy('apply');
    setError(null);
    try {
      const result = await requestEditor<{
        version: number;
        targets: EditorTarget[];
      }>(`${base}/apply`, {
        method: 'POST',
        body: JSON.stringify(proposal),
      });
      setTargets(result.targets);
      setVersion(result.version);
      setProposal(null);
      setInstruction('');
      setNotice(`Saved as version ${result.version}.`);
      setFrameKey((key) => key + 1);
      await refreshState();
    } catch (caught) {
      setError(
        caught instanceof EditorRequestError
          ? caught.message
          : 'That change could not be saved.'
      );
      // A stale original means the site moved on; the frame and the list have
      // to be re-read before another attempt can mean anything.
      if (caught instanceof EditorRequestError && caught.status === 409) {
        setProposal(null);
        setFrameKey((key) => key + 1);
        await refreshState().catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  }

  const sections = useMemo(() => {
    const grouped = new Map<string, EditorTarget[]>();
    for (const target of targets) {
      const list = grouped.get(target.section);
      if (list) list.push(target);
      else grouped.set(target.section, [target]);
    }
    return Array.from(grouped.entries());
  }, [targets]);

  return (
    <div className="flex min-h-screen w-full flex-col gap-4 px-4 py-6 lg:flex-row lg:px-6">
      <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--fs-rule)] px-4 py-3">
          <div>
            <p className="text-sm font-bold text-[var(--fs-ink)]">
              {initial.site.name}
            </p>
            <p className="text-xs text-[var(--fs-ink-faint)]">
              {initial.site.rendersBuiltHtml
                ? `Your site · version ${version || 1}`
                : `Content preview · version ${version || 1}${
                    initial.site.templateSlug
                      ? ` · ${initial.site.templateSlug} template`
                      : ''
                  }`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFrameKey((key) => key + 1)}
            className="shrink-0 rounded-full border border-[var(--fs-rule)] px-3 py-1.5 text-xs font-semibold text-[var(--fs-ink-dim)] transition-colors hover:border-[var(--purple-primary)]/40 hover:text-[var(--fs-ink)]"
          >
            Refresh
          </button>
        </header>
        <iframe
          key={frameKey}
          ref={frame}
          data-testid="site-preview-frame"
          title={`${initial.site.name} preview`}
          src={`${base}/preview`}
          // Opaque origin: the frame renders the client's own site content from
          // our domain, and must not be able to touch the dashboard's session.
          sandbox="allow-scripts"
          className="h-full min-h-[420px] w-full flex-1 border-0 bg-white"
        />
      </section>

      <aside className="flex w-full flex-col gap-4 lg:w-[420px]">
        <nav className="flex gap-1 rounded-full border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] p-1 text-sm shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
          {(
            [
              ['text', 'Words'],
              ['images', 'Pictures'],
              ['request', 'Bigger changes'],
              ['history', 'History'],
            ] as Array<[Tab, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              data-testid={`editor-tab-${value}`}
              className={`flex-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                tab === value
                  ? 'bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] text-white shadow-lg shadow-[var(--purple-primary-lightest)]'
                  : 'text-[var(--fs-ink-dim)] hover:text-[var(--fs-ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'text' ? (
          <div className="flex flex-col gap-4 rounded-2xl border border-[var(--fs-glass-edge)] bg-[var(--fs-glass-bg)] px-4 py-4 shadow-[var(--fs-card-shadow)] backdrop-blur-xl">
            <PolicyNotice decision={contentPolicy} />

            <div>
              <label
                htmlFor="editor-target"
                className="text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink-faint)]"
              >
                What are you changing?
              </label>
              <select
                id="editor-target"
                data-testid="editor-target-select"
                value={selectedId ?? ''}
                onChange={(event) => {
                  setSelectedId(event.target.value || null);
                  setProposal(null);
                }}
                className="mt-1 w-full rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-[box-shadow,border-color] duration-150 hover:border-[var(--purple-primary)]/30 focus:border-[var(--purple-primary)]/40 focus:shadow-[0_0_0_4px_var(--purple-primary-lightest)]"
              >
                <option value="">Click something in your site…</option>
                {sections.map(([section, group]) => (
                  <optgroup key={section} label={section}>
                    {group.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.key}: {target.content.slice(0, 60)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {selected ? (
              <div className="rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--fs-ink-faint)]">
                  {selected.section} · {selected.key}
                </p>
                <p
                  data-testid="editor-current-text"
                  className="mt-1 whitespace-pre-wrap text-sm text-[var(--fs-ink)]"
                >
                  {selected.content}
                </p>
              </div>
            ) : null}

            <div>
              <label
                htmlFor="editor-instruction"
                className="text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink-faint)]"
              >
                What should it say instead?
              </label>
              <textarea
                id="editor-instruction"
                data-testid="editor-instruction"
                value={instruction}
                maxLength={initial.allowance.maxInstructionChars}
                onChange={(event) => setInstruction(event.target.value)}
                rows={3}
                disabled={!canEdit || !selected}
                placeholder="Warmer, and mention that we open on Saturdays"
                className="mt-1 w-full rounded-lg border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-[var(--fs-ink-faint)] hover:border-[var(--purple-primary)]/30 focus:border-[var(--purple-primary)]/40 focus:shadow-[0_0_0_4px_var(--purple-primary-lightest)] disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-[var(--fs-ink-faint)]">
                {used} of {initial.allowance.cap} changes used today.
              </p>
              {/* The monthly number is the one the care plan sells; the daily
                  line above it is only the burst guard. */}
              <p
                data-testid="editor-credits"
                className="mt-0.5 text-xs text-[var(--fs-ink-faint)]"
              >
                {editCreditsLine(credits)}
              </p>
            </div>

            <button
              type="button"
              data-testid="editor-propose"
              onClick={propose}
              disabled={
                !canEdit || !selected || !instruction.trim() || busy !== null
              }
              className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:bg-[linear-gradient(135deg,var(--landing-btn-hover-from),var(--landing-btn-hover-via))] hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:pointer-events-none"
            >
              {busy === 'edit' ? 'Writing…' : 'Suggest a change'}
            </button>

            {proposal ? (
              <div
                data-testid="editor-proposal"
                className="flex flex-col gap-3 rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 px-3 py-3"
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink-faint)]">
                  Before you save
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {diffWords(
                    proposal.originalContent,
                    proposal.replacementContent
                  ).map((part, index) => (
                    <span
                      key={index}
                      className={
                        part.kind === 'removed'
                          ? 'rounded bg-red-600/10 text-red-800 line-through dark:text-red-300'
                          : part.kind === 'added'
                          ? 'rounded bg-emerald-600/10 text-emerald-800 dark:text-emerald-300'
                          : 'text-[var(--fs-ink-dim)]'
                      }
                    >
                      {part.text}
                    </span>
                  ))}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="editor-apply"
                    onClick={apply}
                    disabled={busy !== null}
                    className="rounded-lg bg-[linear-gradient(135deg,var(--landing-btn-from),var(--landing-btn-via))] px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-[var(--purple-primary-lightest)] transition-all duration-200 hover:bg-[linear-gradient(135deg,var(--landing-btn-hover-from),var(--landing-btn-hover-via))] hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-60 disabled:pointer-events-none"
                  >
                    {busy === 'apply' ? 'Saving…' : 'Use this'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setProposal(null)}
                    className="rounded-lg border border-[var(--fs-rule)] px-5 py-2 text-sm font-semibold text-[var(--fs-ink)] transition-colors hover:border-[var(--purple-primary)]/40"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p
                data-testid="editor-error"
                className="rounded-xl border border-red-600/25 bg-red-600/10 px-3 py-2 text-sm text-red-800 dark:text-red-300"
              >
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="text-sm text-[var(--fs-ink-dim)]">{notice}</p>
            ) : null}
          </div>
        ) : null}

        {tab === 'images' ? (
          <ImageSlotsPanel
            base={base}
            policy={initial.policy.image}
            onChanged={async () => {
              setFrameKey((key) => key + 1);
              await refreshState().catch(() => {});
            }}
          />
        ) : null}

        {tab === 'request' ? (
          <EscalationPanel
            workspaceId={workspaceId}
            policy={initial.policy.structural}
            onGoToTab={(next) => setTab(next)}
          />
        ) : null}

        {tab === 'history' ? (
          <VersionHistoryPanel
            base={base}
            versions={versions}
            currentVersion={version}
            policy={contentPolicy}
            onChanged={async () => {
              setFrameKey((key) => key + 1);
              await refreshState().catch(() => {});
            }}
          />
        ) : null}

        <Link
          href={`/dashboard/projects/${workspaceId}`}
          className="text-sm font-semibold text-[var(--fs-ink-dim)] underline underline-offset-4 transition-colors hover:text-[var(--fs-ink)]"
        >
          Back to your project
        </Link>
      </aside>
    </div>
  );
}
