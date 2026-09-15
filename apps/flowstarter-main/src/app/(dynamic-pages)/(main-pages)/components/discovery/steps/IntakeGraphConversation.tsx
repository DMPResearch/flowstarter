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
  optionLabel,
  promptText,
  questionById,
} from '../intake-script';
import { ChipsInput } from '../ChipsInput';
import {
  AgentMessageRow,
  ChatBubble,
  ConversationLog,
  SuggestionChips,
  TypingIndicator,
  chatGroupPositions,
  type BubblePosition,
} from './ConciergePanes';
import { ConnectPortrait } from './ConnectPortrait';
import { PolicyNoticeCard } from './PolicyNoticeCard';
import { RecommendationStep } from './RecommendationStep';
import { SubscriptionStep } from './SubscriptionStep';
import { useAutosizeTextarea } from '../useAutosizeTextarea';
import { useOptionalI18n } from '@/lib/i18n';
import type { PolicyNotice } from '@/lib/policy/copy';
import type {
  IntakeGraphAsk,
  IntakeGraphResume,
  IntakeGraphTurnResult,
} from '@/lib/flowstarter/intake-graph/types';

/**
 * The gate stopped this intake, and with which sentence.
 *
 * `refused` and `hold` are the scope gate's own two words -- the server sends
 * them straight through from `decideRoute` -- so one screen serves both
 * surfaces rather than each learning a private vocabulary for the same two
 * verdicts.
 */
export interface IntakePolicyStop {
  stop: 'refused' | 'hold';
  policy: PolicyNotice | null;
}

/** See `IntakeConversation`'s own copy of this constant for why `min-h-11`. */
const composerClass =
  'min-h-11 w-full flex-1 resize-none rounded-xl border border-[var(--fs-rule)] bg-white px-3.5 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-[var(--fs-ink-faint)] hover:border-[var(--purple-primary)]/30 focus:border-[var(--purple-primary)]/40 focus:shadow-[0_0_0_4px_var(--purple-primary-lightest)] dark:bg-white/[0.03]';

/** Send shares the field's height, radius and horizontal padding — see `composerClass`. */
const composerSendClass = 'h-11 shrink-0 rounded-xl px-3.5';

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
  onPolicyStop,
  locale,
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
  /**
   * The acceptable-use gate ended the intake. The wizard needs to know so it
   * stops advancing; this component needs to know so it stops asking.
   */
  onPolicyStop?: (stop: IntakePolicyStop) => void;
  /**
   * Overridden only by a caller that knows better than the page does. Left
   * unset it reads the dictionary above, which is what makes a Romanian
   * visitor's refusal arrive in Romanian: the notice is written server-side
   * by `@/lib/policy/copy`, in whatever language this field names.
   */
  locale?: 'en' | 'ro';
  t: (key: string) => string;
}) {
  // `useOptionalI18n` rather than `useI18n`: the wizard is mounted on surfaces
  // that thread `t` down as a prop instead of mounting a provider, and this
  // component must not take the page down by being one of them.
  const pageLocale = useOptionalI18n()?.locale;
  const spokenLocale: 'en' | 'ro' =
    locale ?? (pageLocale === 'ro' ? 'ro' : 'en');

  const [threadId, setThreadId] = useState<string | null>(null);
  const [policyStop, setPolicyStop] = useState<IntakePolicyStop | null>(null);
  const [ask, setAsk] = useState<IntakeGraphAsk | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
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
      setErrorKey(result.errorKey ?? null);
      // The visitor's answer is applied whether or not the gate stopped them.
      // The moderator this replaced returned the state from before the turn,
      // so a refused brief was also a discarded one and the preview pane went
      // on reading "You do: Not yet" with nothing said about why.
      onState({
        data: result.data,
        answered: result.answered,
      });
      if (result.policyStop) {
        const stop: IntakePolicyStop = {
          stop: result.policyStop,
          policy: result.policy ?? null,
        };
        setPolicyStop(stop);
        onPolicyStop?.(stop);
      }
    },
    [onState, onPolicyStop]
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
      locale: spokenLocale,
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
      if (!threadId || busy || policyStop) return;
      setBusy(true);
      setErrorKey(null);
      try {
        const result = await postGraph({
          action: 'resume',
          threadId,
          resume: payload,
          data,
          answered,
          locale: spokenLocale,
        });
        applyTurn(result);
      } catch {
        setErrorKey('landing.discovery.chat.errors.required');
      } finally {
        setBusy(false);
      }
    },
    [threadId, busy, policyStop, data, answered, spokenLocale, applyTurn]
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

  // The model's reaction to the visitor's last turn (an answer to a question
  // they asked back, or a natural nudge in place of the raw validation
  // message) and the question itself are one graph turn, so they read as one
  // message: reaction first, then the question, in the same bubble.
  // Once the gate has stopped the intake there is no next question, so the
  // last agent line and the typing indicator both go: the notice below is the
  // whole of what happens next, and leaving a half-finished question above it
  // reads as though the conversation is still going.
  const showsNote = booted && Boolean(ask?.note) && !policyStop;
  const showsPrompt =
    booted && Boolean(agentPrompt) && Boolean(current) && !policyStop;
  const showsCombined = showsNote || showsPrompt;
  const showsTyping = busy && !agentPrompt && !policyStop;
  const showsErrorBubble = Boolean(errorKey) && !ask?.note && !policyStop;

  // Every agent-side bubble in on-screen order, so consecutive ones group
  // (rounded outer corners, squared seams) and the avatar/name show once per
  // run — the same rule `IntakeConversation` groups its own transcript with.
  const sides: Array<'agent' | 'you'> = ['agent'];
  const historyAgentIndex: number[] = [];
  const historyAnswerIndex: number[] = [];
  history.forEach(() => {
    historyAgentIndex.push(sides.push('agent') - 1);
    historyAnswerIndex.push(sides.push('you') - 1);
  });
  const combinedSlotIndex = showsCombined ? sides.push('agent') - 1 : -1;
  const typingSlotIndex = showsTyping ? sides.push('agent') - 1 : -1;
  const errorSlotIndex = showsErrorBubble ? sides.push('agent') - 1 : -1;
  const positions = chatGroupPositions(sides);
  const positionAt = (index: number): BubblePosition =>
    index >= 0 ? positions[index] ?? 'solo' : 'solo';

  return (
    <div className="space-y-3">
      <ConversationLog
        label={t('landing.discovery.chat.logLabel')}
        scrollSignal={answered.length + (busy ? 1 : 0)}
        heightClassName="max-h-[42vh] min-h-[160px]"
      >
        <AgentMessageRow position={positionAt(0)} agentName={agentName}>
          <ChatBubble tone="agent" position={positionAt(0)} animate fitWidth>
            {t('landing.discovery.chat.intro')}
          </ChatBubble>
        </AgentMessageRow>

        {history.map((question, index) => {
          const said = answerText(question, data, t);
          const position = positionAt(historyAgentIndex[index]);
          const answerPosition = positionAt(historyAnswerIndex[index]);
          return (
            <div key={question.id} className="space-y-2">
              <AgentMessageRow position={position} agentName={agentName}>
                <ChatBubble tone="agent" position={position} animate fitWidth>
                  {promptText(question, data, t)}
                </ChatBubble>
              </AgentMessageRow>
              <div className="flex items-center justify-end gap-1.5">
                <ChatBubble tone="you" position={answerPosition} animate>
                  {said || t('landing.discovery.chat.skipped')}
                </ChatBubble>
              </div>
            </div>
          );
        })}

        {showsCombined && (
          <AgentMessageRow
            position={positionAt(combinedSlotIndex)}
            agentName={agentName}
          >
            <ChatBubble
              tone="agent"
              position={positionAt(combinedSlotIndex)}
              animate
              fitWidth
            >
              <div className="space-y-2.5">
                {showsNote && <p>{ask?.note}</p>}
                {showsPrompt && <p>{agentPrompt}</p>}
              </div>
            </ChatBubble>
          </AgentMessageRow>
        )}

        {showsTyping && (
          <AgentMessageRow
            position={positionAt(typingSlotIndex)}
            agentName={agentName}
          >
            <TypingIndicator
              label={t('landing.discovery.chat.thinking')}
              position={positionAt(typingSlotIndex)}
            />
          </AgentMessageRow>
        )}

        {showsErrorBubble && (
          <AgentMessageRow
            position={positionAt(errorSlotIndex)}
            agentName={agentName}
          >
            <ChatBubble
              tone="alert"
              position={positionAt(errorSlotIndex)}
              animate
              fitWidth
            >
              {t(errorKey ?? '')}
            </ChatBubble>
          </AgentMessageRow>
        )}
      </ConversationLog>

      {/*
        The gate's answer, in the gate's own words, where the next question
        would have been. This is the whole of finding 1 from the 2026-09-15
        showcase run: the intake used to end a prohibited brief with
        `status: 'complete'`, `ask: null` and nothing on screen, so the visitor
        sat at "2 of 5 questions answered" with no notice, no refusal and no
        way forward. An answer that cannot be processed now says why.
      */}
      {policyStop && (
        <PolicyNoticeCard
          policy={policyStop.policy}
          testId={`intake-policy-${policyStop.stop}`}
        />
      )}

      {/* No composer once the gate has stopped: the intake is over, and an
          input box that still accepts text is a promise we cannot keep. */}
      {current && ask && !busy && !policyStop && (
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
    // Same gate as the scripted conversation, and `connectPortrait` needs no
    // special case here either: it sits on step 4, whose clause is the one
    // link, already answered on the question immediately before it. So confirm
    // is enabled the moment the panel appears, which is what an optional
    // question should look like.
    const ready = canProceed(question.step as Step, data);
    return (
      <div className="space-y-4 rounded-xl border border-[var(--fs-rule)] bg-[var(--fs-bg-elevated)]/40 p-3.5">
        {question.id === 'selectedTier' ? (
          <RecommendationStep data={data} update={update} t={t} />
        ) : question.id === 'connectPortrait' ? (
          <ConnectPortrait data={data} update={update} t={t} />
        ) : (
          <SubscriptionStep data={data} update={update} t={t} />
        )}
        {/* The commercial panels are required and so never had a skip here.
            The connect offer is optional and must be as easy to decline as to
            accept, so the script's own skip chip is rendered beside confirm. */}
        <SuggestionChips>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onSubmit(question.value(data) || 'confirmed')}
            disabled={!ready}
            aria-disabled={!ready}
          >
            {t('landing.discovery.chat.confirm')}
          </Button>
          {skipChip}
        </SuggestionChips>
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
        <SuggestionChips>
          <Button variant="primary" size="sm" onClick={() => onSubmit(draft)}>
            {t('landing.discovery.chat.done')}
          </Button>
          {skipChip}
        </SuggestionChips>
      </div>
    );
  }

  if (question.kind === 'choice') {
    return (
      <div className="space-y-2.5">
        <SuggestionChips>
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
        </SuggestionChips>
        {/* Chips are a shortcut, not the only door: typed words are mapped
            onto the same choice server-side (`extractAnswers`), the way a
            free-text answer to any other question is. */}
        <TypedAnswer
          question={question}
          draft={draft}
          setDraft={setDraft}
          onSubmit={onSubmit}
          composerRef={composerRef}
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
  t,
}: {
  question: IntakeQuestion;
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (raw: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  t: (key: string) => string;
}) {
  // One line at rest for every question kind — `longtext` used to start at
  // three rows; now it grows into the room it needs instead of claiming it
  // up front.
  useAutosizeTextarea(composerRef, draft);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
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
        rows={1}
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
        className={composerSendClass}
      >
        {t('landing.discovery.chat.send')}
      </Button>
    </div>
  );
}
