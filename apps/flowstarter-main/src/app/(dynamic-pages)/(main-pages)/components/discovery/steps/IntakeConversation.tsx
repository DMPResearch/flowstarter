'use client';

/**
 * Steps 1–6 — the intake, as a conversation.
 *
 * This replaces the four form screens (about / business / goals / commerce) and
 * wraps the two commercial choices (build package, monthly plan) in the same
 * transcript, so a visitor goes from "hello" to a generated preview without
 * ever being shown a page of labelled inputs.
 *
 * What makes it a conversation rather than a form with bubbles:
 *
 *   - The agent reacts before it asks. Every answer gets a line back that
 *     picks up what was said ("Digital products. I'll plan a store with
 *     instant delivery after checkout.") and only then the next question.
 *     The reactions are `intake-script.ts`'s `reflectionText`: chosen by rule
 *     from the stored answer, phrased from the locale catalogue, never from a
 *     model. Rules decide, copy phrases.
 *
 *   - The agent takes a beat. A new question arrives after a short "thinking"
 *     pause, the way a reply does in any chat the visitor already uses. A
 *     question they have already seen (an edit, a step back) comes back at
 *     once: the pause is cadence, not a delay.
 *
 *   - Quick replies live inside the agent's message, lettered A, B, C and
 *     answerable from the keyboard. Once picked, the choice stays where it
 *     was made, ticked, and the rest of the list folds away. Nothing swaps
 *     in a control below the transcript.
 *
 *   - There is one composer, always the same one, at the bottom. Typing
 *     works for every question: words that match a quick reply are that
 *     reply, and words the agent does not understand get an answer in the
 *     agent's own voice, not a red validation message.
 *
 *   - No progress bar, no step counter, no edit button on every line. An
 *     earlier answer is still editable (the visitor's own bubble, or a ticked
 *     choice, re-opens the question with the old answer waiting), but the
 *     affordance is quiet. Editing rewrites the bubble in place: the
 *     transcript is a pure projection of (answers, data), so there is no
 *     second copy of the truth to drift.
 *
 * What has not changed: the order, the validation, the required-field gate
 * and the decision that the intake is finished are all `intake-script.ts`'s,
 * deterministic and model-free. This component only draws them. There is no
 * way to reach the preview with a required question unanswered — the two
 * commercial panels keep their cards, and a four-way price comparison is not
 * something a chat bubble does well, but they are turns in the same
 * conversation like any other, not something a visitor can skip past.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
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
  nextQuestion,
  optionLabel,
  promptText,
  questionById,
  reflectionText,
  shortcutLetter,
} from '../intake-script';
import { ChatBubble, ConversationLog } from './ConciergePanes';
import { RecommendationStep } from './RecommendationStep';
import { SubscriptionStep } from './SubscriptionStep';

/** The beat before a new question. Long enough to read as a reply, short enough never to feel like waiting. */
export const DEFAULT_PACE_MS = 550;

/** Up to this many quick replies are a lettered list; more become a chip cloud. */
const MAX_LETTERED = 6;

const composerClass =
  'w-full flex-1 resize-none rounded-xl border border-[var(--fs-rule)] bg-white px-3.5 py-2.5 text-sm text-[var(--fs-ink)] outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-[var(--fs-ink-faint)] hover:border-[var(--purple-primary)]/30 focus:border-[var(--purple-primary)]/40 focus:shadow-[0_0_0_4px_var(--purple-primary-lightest)] dark:bg-white/[0.03]';

const rowClass =
  'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[13px] font-medium transition-colors';

const rowIdleClass = `${rowClass} border-[var(--fs-rule)] bg-white/60 text-[var(--fs-ink)] hover:border-[var(--purple-primary)]/50 hover:bg-[var(--purple-primary)]/[0.06] dark:bg-white/[0.02]`;

const rowPickedClass = `${rowClass} border-[var(--purple-primary)]/40 bg-[var(--purple-primary)]/[0.08] text-[var(--fs-ink)]`;

const chipClass =
  'rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors';

const chipIdleClass = `${chipClass} border-[var(--fs-rule)] text-[var(--fs-ink)] hover:border-[var(--purple-primary)]/50 hover:bg-[var(--purple-primary)]/[0.06]`;

const chipPickedClass = `${chipClass} border-[var(--purple-primary)]/50 bg-[var(--purple-primary)]/[0.1] text-[var(--fs-ink)]`;

const skipClass =
  'text-[12px] font-medium text-[var(--fs-ink-faint)] underline-offset-2 transition-colors hover:text-[var(--purple-primary)] hover:underline';

function isTyping(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT';
}

export function IntakeConversation({
  data,
  update,
  answered,
  onAnswer,
  paceMs = DEFAULT_PACE_MS,
  t,
}: {
  data: DiscoveryData;
  update: <K extends keyof DiscoveryData>(
    key: K,
    value: DiscoveryData[K]
  ) => void;
  /** Question ids the visitor has dealt with, in the order they dealt with them. */
  answered: readonly IntakeQuestionId[];
  /** Applies one answer and files the question as answered. Empty = skipped. */
  onAnswer: (id: IntakeQuestionId, raw: string) => void;
  /** The agent's pause before a question it has not asked yet. 0 = none. */
  paceMs?: number;
  t: (key: string) => string;
}) {
  const [editing, setEditing] = useState<IntakeQuestionId | null>(null);
  const [draft, setDraft] = useState('');
  const [typed, setTyped] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  /** Questions the agent has already put on screen: those come back at once. */
  const revealed = useRef<Set<IntakeQuestionId>>(new Set());

  const pending = useMemo(() => nextQuestion(data, answered), [data, answered]);
  const current: IntakeQuestion | null = editing
    ? questionById(editing) ?? null
    : pending;

  const history = useMemo(
    () => answeredQuestions(data, answered),
    [data, answered]
  );

  // The beat. Only a question the agent has never asked gets one; an edit or
  // a step back returns a familiar question instantly.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!currentId) {
      setThinking(false);
      return;
    }
    if (paceMs <= 0 || revealed.current.has(currentId)) {
      revealed.current.add(currentId);
      setThinking(false);
      return;
    }
    setThinking(true);
    const timer = setTimeout(() => {
      revealed.current.add(currentId);
      setThinking(false);
    }, paceMs);
    return () => clearTimeout(timer);
  }, [currentId, paceMs]);

  // The composer opens holding whatever is already on file: an edit shows the
  // old answer, and a restored draft from before this screen existed shows the
  // value the form captured rather than asking for it again from nothing.
  useEffect(() => {
    if (!currentId) return;
    const question = questionById(currentId);
    setDraft(question ? question.value(data) : '');
    setTyped('');
    setErrorKey(null);
    // Deliberately keyed on the question alone: re-running as `data` changes
    // would overwrite what the visitor is in the middle of typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Focus follows the question once it is on screen: the composer for words,
  // the frame for a lettered list so A/B/C work without a click first.
  useEffect(() => {
    if (thinking || !current) return;
    if (current.kind === 'choice' && !current.freeText) {
      frameRef.current?.focus?.();
    } else if (current.kind !== 'panel') {
      composerRef.current?.focus?.();
    }
  }, [thinking, current]);

  const submit = useCallback(
    (raw: string) => {
      if (!current) return;
      const text = raw.trim();
      if (current.required && !text) {
        setErrorKey('landing.discovery.chat.errors.required');
        return;
      }
      // An optional question with nothing in it is a skip, not a bad answer:
      // validators never run on it.
      const failed = text ? current.validate?.(text) ?? null : null;
      if (failed) {
        setErrorKey(failed);
        return;
      }
      setErrorKey(null);
      setEditing(null);
      onAnswer(current.id, text);
    },
    [current, onAnswer]
  );

  const lettered = useMemo(
    () =>
      current?.kind === 'choice' &&
      (current.options?.length ?? 0) <= MAX_LETTERED
        ? current.options ?? []
        : null,
    [current]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!lettered || thinking || isTyping(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const index = event.key.toUpperCase().charCodeAt(0) - 65;
      const option = lettered[index];
      if (!option) return;
      event.preventDefault();
      submit(option.value);
    },
    [lettered, submit, thinking]
  );

  const agentName = t('landing.discovery.chat.agentName');
  const editLabel = t('landing.discovery.chat.edit');
  const showsComposer = current && !thinking && current.kind !== 'panel';

  return (
    <div
      ref={frameRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="space-y-3 outline-none"
    >
      <ConversationLog
        label={t('landing.discovery.chat.logLabel')}
        scrollSignal={answered.length + (editing ? 1 : 0) + (thinking ? 1 : 0)}
      >
        <ChatBubble tone="agent" author={agentName}>
          {t('landing.discovery.chat.intro')}
        </ChatBubble>

        {history.map((question) => (
          <AnsweredTurn
            key={question.id}
            question={question}
            data={data}
            editLabel={editLabel}
            onEdit={() => setEditing(question.id)}
            t={t}
          />
        ))}

        {thinking && (
          <div role="status" aria-label={t('landing.discovery.chat.thinking')}>
            <ChatBubble tone="agent">
              <ThinkingDots />
            </ChatBubble>
          </div>
        )}

        {current && !thinking && (
          <ChatBubble tone="agent" author={editing ? agentName : undefined}>
            <div className="space-y-2.5">
              <p>
                {editing
                  ? `${t('landing.discovery.chat.reask')} ${promptText(
                      current,
                      data,
                      t
                    )}`
                  : promptText(current, data, t)}
              </p>
              <Replies
                question={current}
                data={data}
                update={update}
                draft={draft}
                setDraft={setDraft}
                onSubmit={submit}
                t={t}
              />
            </div>
          </ChatBubble>
        )}

        {errorKey && !thinking && (
          <ChatBubble tone="agent">{t(errorKey)}</ChatBubble>
        )}
      </ConversationLog>

      {showsComposer && (
        <Composer
          key={current.id}
          question={current}
          draft={draft}
          setDraft={setDraft}
          typed={typed}
          setTyped={setTyped}
          onSubmit={submit}
          composerRef={composerRef}
          t={t}
        />
      )}
    </div>
  );
}

/**
 * One question already dealt with: the agent's line, the answer where it was
 * given (in the bubble for a pick, on the right for words), and what the
 * agent said back.
 */
function AnsweredTurn({
  question,
  data,
  editLabel,
  onEdit,
  t,
}: {
  question: IntakeQuestion;
  data: DiscoveryData;
  editLabel: string;
  onEdit: () => void;
  t: (key: string) => string;
}) {
  const prompt = promptText(question, data, t);
  const said = answerText(question, data, t);
  const reflection = reflectionText(question, data, t);
  const editName = `${editLabel}: ${prompt}`;
  const picked =
    said &&
    (question.kind === 'choice' ||
      question.kind === 'multi' ||
      question.kind === 'panel');

  return (
    <div className="space-y-2">
      <ChatBubble tone="agent">
        <div className="space-y-2.5">
          <p>{prompt}</p>
          {picked && (
            <div className="flex flex-wrap gap-1.5">
              {said
                .split(',')
                .map((label) => label.trim())
                .filter(Boolean)
                .map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={onEdit}
                    aria-label={editName}
                    title={editLabel}
                    className={
                      question.kind === 'multi'
                        ? chipPickedClass
                        : rowPickedClass
                    }
                  >
                    <span>{label}</span>
                    <Tick />
                  </button>
                ))}
            </div>
          )}
        </div>
      </ChatBubble>

      {!picked && (
        <div className="group flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={editName}
            className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold text-[var(--fs-ink-faint)] underline-offset-2 opacity-0 transition-opacity hover:text-[var(--purple-primary)] hover:underline focus-visible:opacity-100 group-hover:opacity-100"
          >
            {editLabel}
          </button>
          {/* Full width, so the bubble's own max-width is measured against the
              column and a short answer never wraps mid-name. */}
          <div className="min-w-0 flex-1">
            {said ? (
              <ChatBubble tone="you">{said}</ChatBubble>
            ) : (
              <div className="flex justify-end">
                <ChatBubble tone="earlier">
                  {t('landing.discovery.chat.skipped')}
                </ChatBubble>
              </div>
            )}
          </div>
        </div>
      )}

      {reflection && <ChatBubble tone="agent">{reflection}</ChatBubble>}
    </div>
  );
}

/**
 * The quick replies for the question on screen, inside the agent's message:
 * a lettered list or a chip cloud for a choice, toggling chips for a multi,
 * the price cards for the two commercial decisions. Words go in the composer.
 */
function Replies({
  question,
  data,
  update,
  draft,
  setDraft,
  onSubmit,
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
  t: (key: string) => string;
}) {
  const skip = !question.required && (
    <button type="button" onClick={() => onSubmit('')} className={skipClass}>
      {t('landing.discovery.chat.skip')}
    </button>
  );

  if (question.kind === 'panel') {
    // `canProceed` is still the gate — the conversation renders the decision,
    // it does not get to decide it has been made.
    const ready = canProceed(question.step as Step, data);
    return (
      <div className="space-y-4 rounded-xl border border-[var(--fs-rule)] bg-white/60 p-3.5 dark:bg-white/[0.02]">
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

  const options = question.options ?? [];

  if (question.kind === 'multi') {
    const chosen = draft
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const has = (value: string) =>
      chosen.some((item) => item.toLowerCase() === value.toLowerCase());
    const toggle = (value: string) =>
      setDraft(
        (has(value)
          ? chosen.filter((item) => item.toLowerCase() !== value.toLowerCase())
          : [...chosen, value]
        ).join(', ')
      );
    const extras = chosen.filter(
      (item) =>
        !options.some(
          (option) => option.value.toLowerCase() === item.toLowerCase()
        )
    );
    return (
      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => {
            const active = has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => toggle(option.value)}
                aria-pressed={active}
                className={active ? chipPickedClass : chipIdleClass}
              >
                {optionLabel(option, t)}
                {active && <Tick />}
              </button>
            );
          })}
          {extras.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => toggle(item)}
              aria-pressed
              className={chipPickedClass}
            >
              {item}
              <Tick />
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onSubmit(draft)}
            disabled={question.required && chosen.length === 0}
          >
            {t('landing.discovery.chat.done')}
          </Button>
          {skip}
        </div>
      </div>
    );
  }

  if (question.kind === 'choice') {
    if (options.length <= MAX_LETTERED) {
      return (
        <div className="space-y-1.5">
          {options.map((option: IntakeOption, index) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSubmit(option.value)}
              className={rowIdleClass}
            >
              <Key letter={shortcutLetter(index)} />
              <span className="flex-1">{optionLabel(option, t)}</span>
            </button>
          ))}
          {skip && <div className="pt-1">{skip}</div>}
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {options.map((option: IntakeOption) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSubmit(option.value)}
              className={chipIdleClass}
            >
              {optionLabel(option, t)}
            </button>
          ))}
        </div>
        {skip}
      </div>
    );
  }

  // Words: the composer under the log is the answer box; here only the way out.
  return skip ? <div>{skip}</div> : null;
}

/**
 * The one composer, under the log. It is the same box for every question: a
 * typed answer to a choice is matched against the quick replies, and for a
 * multi it is added to whatever chips are ticked.
 */
function Composer({
  question,
  draft,
  setDraft,
  typed,
  setTyped,
  onSubmit,
  composerRef,
  t,
}: {
  question: IntakeQuestion;
  draft: string;
  setDraft: (value: string) => void;
  typed: string;
  setTyped: (value: string) => void;
  onSubmit: (raw: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  t: (key: string) => string;
}) {
  const isWords = question.kind === 'text' || question.kind === 'longtext';
  // For prose the composer *is* the answer, so it opens holding the old one
  // on an edit. For picks it is the side door, and starts empty.
  const value = isWords ? draft : typed;
  const setValue = isWords ? setDraft : setTyped;
  const send = () => {
    if (question.kind === 'multi') {
      const words = typed.trim();
      onSubmit(words ? [draft, words].filter(Boolean).join(', ') : draft);
      return;
    }
    onSubmit(value);
  };
  const placeholder = isWords
    ? question.placeholderKey
      ? t(question.placeholderKey)
      : t('landing.discovery.chat.composerPlaceholder')
    : question.placeholderKey
    ? t(question.placeholderKey)
    : t('landing.discovery.chat.typeInstead');

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <textarea
        ref={composerRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line — the convention every
          // chat the visitor already uses follows.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
        rows={question.kind === 'longtext' ? 3 : 1}
        aria-label={t('landing.discovery.chat.composerLabel')}
        placeholder={placeholder}
        className={composerClass}
      />
      <Button
        variant="primary"
        size="sm"
        onClick={send}
        disabled={question.required && isWords && value.trim().length === 0}
      >
        {t('landing.discovery.chat.send')}
      </Button>
    </div>
  );
}

function Key({ letter }: { letter: string }) {
  return (
    <kbd
      aria-hidden
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--fs-rule)] bg-white text-[10px] font-semibold text-[var(--fs-ink-faint)] dark:bg-white/[0.06]"
    >
      {letter}
    </kbd>
  );
}

function Tick(): ReactNode {
  return (
    <svg
      aria-hidden
      className="ml-1 inline h-3.5 w-3.5 shrink-0 text-[var(--purple-primary)]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={3}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-0.5" aria-hidden>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--fs-ink-faint)]"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  );
}
