'use client';

/**
 * Graph-backed intake conversation.
 *
 * Same UI bones as `IntakeConversation`, but the agent line and multi-field
 * extract come from `/api/discovery/intake-graph` (LangGraph HITL). The script
 * still owns validation, order, and "done" — the API returns DiscoveryData the
 * wizard already understands.
 *
 * Behind `NEXT_PUBLIC_FLOWSTARTER_INTAKE_GRAPH=true`. The scripted component
 * remains the default until this path is proven.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Button } from '@flowstarter/flow-design-system';
import { type DiscoveryData, type Step, canProceed } from '../discovery.logic';
import {
  type IntakeOption,
  type IntakeQuestion,
  type IntakeQuestionId,
  answerText,
  answeredQuestions,
  interpolate,
  optionLabel,
  promptText,
  questionById,
} from '../intake-script';
import { ChipsInput } from '../ChipsInput';
import { ChatBubble, ConversationLog } from './ConciergePanes';
import { RecommendationStep } from './RecommendationStep';
import { SubscriptionStep } from './SubscriptionStep';
import type {
  IntakeGraphAsk,
  IntakeGraphResume,
  IntakeGraphTurnResult,
} from '@/lib/flowstarter/intake-graph/types';

const composerClass =
  'w-full flex-1 resize-none rounded-xl border border-[var(--fs-rule)] bg-white px-3.5 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-[var(--fs-ink-faint)] hover:border-[var(--purple-primary)]/30 focus:border-[var(--purple-primary)]/40 focus:shadow-[0_0_0_4px_var(--purple-primary-lightest)] dark:bg-white/[0.03]';

const chipClass =
  'rounded-full border px-3 py-1.5 text-sm font-semibold transition-all border-[var(--fs-rule)] text-[var(--fs-ink)] hover:border-[var(--purple-primary)]/50 hover:bg-[var(--purple-primary)]/[0.06]';

async function postGraph(
  body: Record<string, unknown>
): Promise<IntakeGraphTurnResult> {
  const response = await fetch('/api/discovery/intake-graph', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`intake-graph HTTP ${response.status}`);
  }
  return (await response.json()) as IntakeGraphTurnResult;
}

export function IntakeGraphConversation({
  data,
  update,
  answered,
  onState,
  locale = 'en',
  t,
}: {
  data: DiscoveryData;
  update: <K extends keyof DiscoveryData>(
    key: K,
    value: DiscoveryData[K]
  ) => void;
  answered: readonly IntakeQuestionId[];
  onState: (next: {
    data: DiscoveryData;
    answered: IntakeQuestionId[];
  }) => void;
  locale?: 'en' | 'ro';
  t: (key: string) => string;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [ask, setAsk] = useState<IntakeGraphAsk | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 1 });
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [booted, setBooted] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const history = useMemo(
    () => answeredQuestions(data, answered),
    [data, answered]
  );

  const current: IntakeQuestion | null = ask
    ? questionById(ask.questionId) ?? null
    : null;

  const applyTurn = useCallback(
    (result: IntakeGraphTurnResult) => {
      setThreadId(result.threadId);
      setAsk(result.ask);
      setAgentPrompt(result.ask?.prompt ?? null);
      setProgress(result.progress);
      setErrorKey(result.errorKey ?? null);
      onState({
        data: result.data,
        answered: result.answered,
      });
    },
    [onState]
  );

  useEffect(() => {
    // No bootRef: React Strict Mode runs effect → cleanup → effect on the
    // same instance. A latch would swallow the second start after the first
    // was cancelled, and the UI would sit on "Loading…" forever.
    let cancelled = false;
    setBusy(true);
    postGraph({
      action: 'start',
      data,
      answered,
      locale,
    })
      .then((result) => {
        if (cancelled) return;
        applyTurn(result);
        setBooted(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[intake-graph] start failed', error);
        setBooted(true);
        setErrorKey('landing.discovery.chat.errors.required');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // Boot once with the draft the wizard already held.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ask) return;
    const question = questionById(ask.questionId);
    setDraft(question ? question.value(data) : '');
    composerRef.current?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.questionId]);

  const resume = useCallback(
    async (payload: IntakeGraphResume) => {
      if (!threadId || busy) return;
      setBusy(true);
      setErrorKey(null);
      try {
        const result = await postGraph({
          action: 'resume',
          threadId,
          resume: payload,
          data,
          answered,
          locale,
        });
        applyTurn(result);
      } catch {
        setErrorKey('landing.discovery.chat.errors.required');
      } finally {
        setBusy(false);
      }
    },
    [threadId, busy, data, answered, locale, applyTurn]
  );

  const submit = useCallback(
    (raw: string) => {
      if (!current || !ask) return;
      const text = raw.trim();
      if (ask.type === 'panel') {
        void resume({ kind: 'panel', value: text || 'confirmed' });
        return;
      }
      if (!text) {
        if (current.required) {
          setErrorKey('landing.discovery.chat.errors.required');
          return;
        }
        void resume({ kind: 'skip' });
        return;
      }
      void resume({ kind: 'text', text });
    },
    [current, ask, resume]
  );

  const agentName = t('landing.discovery.chat.agentName');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div
          className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--fs-rule)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={t('landing.discovery.chat.progressLabel')}
        >
          <div
            className="h-full rounded-full bg-[var(--purple-primary)] transition-[width] duration-300"
            style={{
              width: `${
                progress.total === 0
                  ? 100
                  : Math.round((progress.done / progress.total) * 100)
              }%`,
            }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--fs-ink-faint)]">
          {interpolate(t('landing.discovery.chat.progressCount'), {
            done: progress.done,
            total: progress.total,
          })}
        </span>
      </div>

      <ConversationLog
        label={t('landing.discovery.chat.logLabel')}
        scrollSignal={answered.length + (busy ? 1 : 0)}
      >
        <ChatBubble tone="agent" author={agentName}>
          {t('landing.discovery.chat.intro')}
        </ChatBubble>

        {history.map((question) => {
          const said = answerText(question, data, t);
          return (
            <div key={question.id} className="space-y-2">
              <ChatBubble tone="agent">
                {promptText(question, data, t)}
              </ChatBubble>
              <div className="flex items-center justify-end gap-1.5">
                <ChatBubble tone="you">
                  {said || t('landing.discovery.chat.skipped')}
                </ChatBubble>
              </div>
            </div>
          );
        })}

        {/* The model's reaction to the visitor's last turn: an answer to a
            question they asked back, or a natural nudge in place of the raw
            validation message. Shown once, ahead of the (possibly repeated)
            question below. */}
        {booted && ask?.note && (
          <ChatBubble tone="agent" author={agentName}>
            {ask.note}
          </ChatBubble>
        )}

        {booted && agentPrompt && current && (
          <ChatBubble tone="agent" author={agentName}>
            {agentPrompt}
          </ChatBubble>
        )}

        {busy && !agentPrompt && (
          <ChatBubble tone="agent">{t('app.loadingExperience')}</ChatBubble>
        )}

        {errorKey && !ask?.note && (
          <ChatBubble tone="alert">{t(errorKey)}</ChatBubble>
        )}
      </ConversationLog>

      {current && ask && !busy && (
        <Composer
          key={current.id}
          question={current}
          data={data}
          update={update}
          draft={draft}
          setDraft={setDraft}
          onSubmit={submit}
          composerRef={composerRef}
          t={t}
        />
      )}
    </div>
  );
}

function Composer({
  question,
  data,
  update,
  draft,
  setDraft,
  onSubmit,
  composerRef,
  t,
}: {
  question: IntakeQuestion;
  data: DiscoveryData;
  update: <K extends keyof DiscoveryData>(
    key: K,
    value: DiscoveryData[K]
  ) => void;
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (raw: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  t: (key: string) => string;
}) {
  const skipChip = !question.required && (
    <button
      type="button"
      onClick={() => onSubmit('')}
      className={`${chipClass} border-dashed text-[var(--fs-ink-faint)]`}
    >
      {t('landing.discovery.chat.skip')}
    </button>
  );

  if (question.kind === 'panel') {
    const ready = canProceed(question.step as Step, data);
    return (
      <div className="space-y-4 rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 p-3.5">
        {question.id === 'selectedTier' ? (
          <RecommendationStep data={data} update={update} t={t} />
        ) : (
          <SubscriptionStep data={data} update={update} t={t} />
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => onSubmit(question.value(data) || 'confirmed')}
          disabled={!ready}
          aria-disabled={!ready}
        >
          {t('landing.discovery.chat.confirm')}
        </Button>
      </div>
    );
  }

  if (question.kind === 'multi') {
    return (
      <div className="space-y-2.5">
        <ChipsInput
          value={draft}
          presets={(question.options ?? []).map((option) => option.value)}
          onChange={setDraft}
          placeholder={
            question.placeholderKey ? t(question.placeholderKey) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => onSubmit(draft)}>
            {t('landing.discovery.chat.done')}
          </Button>
          {skipChip}
        </div>
      </div>
    );
  }

  if (question.kind === 'choice') {
    return (
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((option: IntakeOption) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSubmit(option.value)}
              className={chipClass}
            >
              {optionLabel(option, t)}
            </button>
          ))}
          {skipChip}
        </div>
        {/* Chips are a shortcut, not the only door: typed words are mapped
            onto the same choice server-side (`extractAnswers`), the way a
            free-text answer to any other question is. */}
        <TypedAnswer
          question={question}
          draft={draft}
          setDraft={setDraft}
          onSubmit={onSubmit}
          composerRef={composerRef}
          rows={1}
          t={t}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <TypedAnswer
        question={question}
        draft={draft}
        setDraft={setDraft}
        onSubmit={onSubmit}
        composerRef={composerRef}
        rows={question.kind === 'longtext' ? 3 : 1}
        t={t}
      />
      {!question.required && <div className="flex gap-2">{skipChip}</div>}
    </div>
  );
}

function TypedAnswer({
  question,
  draft,
  setDraft,
  onSubmit,
  composerRef,
  rows,
  t,
}: {
  question: IntakeQuestion;
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (raw: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  rows: number;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <textarea
        ref={composerRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit(draft);
          }
        }}
        rows={rows}
        aria-label={t('landing.discovery.chat.composerLabel')}
        placeholder={
          question.placeholderKey
            ? t(question.placeholderKey)
            : t('landing.discovery.chat.composerPlaceholder')
        }
        className={composerClass}
      />
      <Button
        variant="primary"
        size="sm"
        onClick={() => onSubmit(draft)}
        disabled={question.required && draft.trim().length === 0}
      >
        {t('landing.discovery.chat.send')}
      </Button>
    </div>
  );
}
