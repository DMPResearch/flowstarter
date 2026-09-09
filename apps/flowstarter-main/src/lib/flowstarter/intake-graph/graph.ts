import 'server-only';

/**
 * LangGraph HITL intake.
 *
 *   rules decide  → `intake-script.ts` (next question, validate, apply, done)
 *   models phrase → `phraseAsk` / `extractAnswers` / `answerVisitorQuestion` /
 *                    `phraseClarification`
 *   interrupt     → pause for the visitor; resume with Command
 *
 * Checkpoints live in a process-local MemorySaver. That matches the single-
 * instance funnel rate limit; if the process restarts mid-chat the API rebuilds
 * from the client mirror and fails open to the scripted prompt.
 */
import { randomUUID } from 'node:crypto';
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
} from '@langchain/langgraph';
import {
  type DiscoveryData,
  EMPTY_DISCOVERY,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import {
  type IntakeQuestionId,
  answerText,
  nextQuestion,
  promptText,
  questionById,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';
import en from '@/locales/en';
import ro from '@/locales/ro';
import {
  applyBonusExtracted,
  applyResumeTurn,
  localeTag,
  mergeDiscovery,
  progressFor,
  sanitizeAnswered,
  scriptedAsk,
} from './script-bridge';
import {
  answerVisitorQuestion,
  extractAnswers,
  phraseAsk,
  phraseClarification,
} from './llm-turns';
import type {
  IntakeGraphAsk,
  IntakeGraphLocale,
  IntakeGraphResume,
  IntakeGraphResumeInput,
  IntakeGraphStartInput,
  IntakeGraphTurnResult,
} from './types';

type Translate = (key: string) => string;

const IntakeState = Annotation.Root({
  data: Annotation<DiscoveryData>,
  answered: Annotation<IntakeQuestionId[]>,
  locale: Annotation<IntakeGraphLocale>,
  status: Annotation<'pending' | 'complete'>,
  /** Last ask surfaced to the client (also carried on the interrupt value). */
  lastAsk: Annotation<IntakeGraphAsk | null>,
  errorKey: Annotation<string | null>,
  /**
   * A reactive line earned on the visitor's last turn — an answer to a
   * question they asked back, folded in alongside a valid answer to the
   * pending question. Shown once, attached to whichever ask comes next
   * (built fresh in the following node run), then cleared.
   */
  pendingNote: Annotation<string | null>,
});

type GraphState = typeof IntakeState.State;

export type IntakeGraphDeps = {
  phraseAsk: typeof phraseAsk;
  extractAnswers: typeof extractAnswers;
  answerVisitorQuestion: typeof answerVisitorQuestion;
  phraseClarification: typeof phraseClarification;
  translate: (locale: IntakeGraphLocale) => Translate;
};

const EN = en as unknown as Record<string, string>;
const RO = ro as unknown as Record<string, string>;

const defaultTranslate = (locale: IntakeGraphLocale): Translate => {
  return (key) => (locale === 'ro' ? RO[key] : undefined) ?? EN[key] ?? key;
};

const defaultDeps: IntakeGraphDeps = {
  phraseAsk,
  extractAnswers,
  answerVisitorQuestion,
  phraseClarification,
  translate: defaultTranslate,
};

let deps: IntakeGraphDeps = defaultDeps;

/** Test seam — swap LLM + locale without mocking the whole module graph. */
export function setIntakeGraphDeps(partial: Partial<IntakeGraphDeps>): void {
  deps = { ...defaultDeps, ...partial };
}

export function resetIntakeGraphDeps(): void {
  deps = defaultDeps;
}

function parseResume(value: unknown): IntakeGraphResume {
  if (!value || typeof value !== 'object') {
    return { kind: 'text', text: String(value ?? '') };
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'skip') return { kind: 'skip' };
  if (record.kind === 'panel') {
    return { kind: 'panel', value: String(record.value ?? '') };
  }
  if (record.kind === 'text') {
    return { kind: 'text', text: String(record.text ?? '') };
  }
  // Back-compat: bare `{ text }` from early clients.
  if (typeof record.text === 'string') {
    return { kind: 'text', text: record.text };
  }
  return { kind: 'text', text: '' };
}

/** The last question actually dealt with, and what the visitor's bubble says — context for `phraseAsk` to react to. */
function lastAnswerContext(
  state: GraphState,
  t: Translate
): { questionId: string; text: string } | null {
  const lastId = state.answered[state.answered.length - 1];
  if (!lastId) return null;
  const question = questionById(lastId);
  if (!question) return null;
  const text = answerText(question, state.data, t);
  return text ? { questionId: question.id, text } : null;
}

async function buildAsk(
  state: GraphState,
  questionId: IntakeQuestionId,
  note: string | null
): Promise<IntakeGraphAsk> {
  const question = nextQuestion(state.data, state.answered);
  // Prefer the id we already decided; fall back to live nextQuestion.
  const pending =
    question && question.id === questionId
      ? question
      : nextQuestion(state.data, state.answered);
  if (!pending) {
    throw new Error('buildAsk called with no pending question');
  }
  const t = deps.translate(state.locale);
  const scripted = scriptedAsk(pending, state.data, t);
  if (pending.kind === 'panel') {
    return note ? { ...scripted, note } : scripted;
  }

  try {
    const prompt = await deps.phraseAsk({
      question: pending,
      scriptedPrompt: scripted.prompt,
      data: state.data,
      answered: state.answered,
      locale: state.locale,
      t,
      lastAnswer: lastAnswerContext(state, t),
    });
    const built = { ...scripted, prompt: prompt.trim() || scripted.prompt };
    return note ? { ...built, note } : built;
  } catch {
    return note ? { ...scripted, note } : scripted;
  }
}

async function turnNode(state: GraphState): Promise<Partial<GraphState>> {
  const pending = nextQuestion(state.data, state.answered);
  if (!pending) {
    return {
      status: 'complete',
      lastAsk: null,
      errorKey: null,
      pendingNote: null,
    };
  }

  const ask = await buildAsk(state, pending.id, state.pendingNote ?? null);
  let errorKey: string | null = null;
  /** `undefined` = leave `ask.note` (the carried-over reaction) as it is. */
  let note: string | null | undefined;
  let data = state.data;
  let answered = state.answered;

  // Stay in this node until the pending question validates. Each retry
  // re-interrupts with the same ask; only `errorKey`/`note` change.
  for (;;) {
    const payload =
      note === undefined
        ? { ...ask, errorKey }
        : { ...ask, errorKey, note: note ?? undefined };
    const resumeRaw = interrupt(payload);
    const resume = parseResume(resumeRaw);

    let extracted: Array<{ id: string; value: string }> = [];
    let visitorReply: string | null = null;

    if (
      resume.kind === 'text' &&
      resume.text.trim() &&
      pending.kind !== 'panel'
    ) {
      try {
        extracted = await deps.extractAnswers({
          pendingId: pending.id,
          userText: resume.text,
          data,
          answered,
          locale: state.locale,
          t: deps.translate(state.locale),
        });
      } catch {
        extracted = [];
      }

      // A deterministic gate decides which turns are even worth a second
      // model call: only one that actually contains a `?` pays for it.
      if (resume.text.includes('?')) {
        try {
          visitorReply = await deps.answerVisitorQuestion({
            questionText: resume.text,
            pending,
            data,
            locale: state.locale,
            t: deps.translate(state.locale),
          });
        } catch {
          visitorReply = null;
        }
      }
    }

    const answeredPending = extracted.some((entry) => entry.id === pending.id);

    // A pure question: nothing usable for the pending field itself. Fold in
    // any *other* fields volunteered in the same breath, answer the
    // question, and put the same pending question back — never run the raw
    // text through its own validator, which is how "why do you need my
    // email?" would otherwise fail as a bad email address instead of getting
    // an answer.
    if (visitorReply && !answeredPending) {
      const bonus = applyBonusExtracted(data, answered, pending.id, extracted);
      data = bonus.data;
      answered = bonus.answered;
      errorKey = null;
      note = visitorReply;
      continue;
    }

    const applied = applyResumeTurn({
      data,
      answered,
      pendingId: pending.id,
      resume,
      extracted,
    });

    if (applied.errorKey) {
      errorKey = applied.errorKey;
      try {
        note = await deps.phraseClarification({
          pending,
          scriptedError: deps.translate(state.locale)(applied.errorKey),
          rawText: resume.kind === 'text' ? resume.text : '',
          locale: state.locale,
          t: deps.translate(state.locale),
        });
      } catch {
        // Fail open: the UI falls back to the raw scripted error text when
        // `note` is unset, exactly as it always has.
        note = null;
      }
      continue;
    }

    return {
      data: applied.data,
      answered: applied.answered,
      status: 'pending',
      lastAsk: ask,
      errorKey: null,
      // A question asked alongside a valid answer gets its reply attached to
      // the *next* ask, built fresh by the following node run.
      pendingNote: visitorReply,
    };
  }
}

function routeAfterTurn(state: GraphState): typeof END | 'turn' {
  if (state.status === 'complete') return END;
  const pending = nextQuestion(state.data, state.answered);
  return pending ? 'turn' : END;
}

const checkpointer = (() => {
  // Survive Next.js HMR / duplicate module evaluations so a start→resume
  // pair in the same process still shares the checkpoint.
  const g = globalThis as unknown as {
    __flowstarterIntakeGraphCheckpointer?: InstanceType<typeof MemorySaver>;
  };
  if (!g.__flowstarterIntakeGraphCheckpointer) {
    g.__flowstarterIntakeGraphCheckpointer = new MemorySaver();
  }
  return g.__flowstarterIntakeGraphCheckpointer;
})();

function buildCompiledGraph() {
  return new StateGraph(IntakeState)
    .addNode('turn', turnNode)
    .addEdge(START, 'turn')
    .addConditionalEdges('turn', routeAfterTurn, {
      turn: 'turn',
      [END]: END,
    })
    .compile({ checkpointer });
}

type CompiledIntakeGraph = ReturnType<typeof buildCompiledGraph>;

const compiled = (() => {
  const g = globalThis as unknown as {
    __flowstarterIntakeGraph?: CompiledIntakeGraph;
  };
  if (!g.__flowstarterIntakeGraph) {
    g.__flowstarterIntakeGraph = buildCompiledGraph();
  }
  return g.__flowstarterIntakeGraph;
})();

function toResult(
  threadId: string,
  state: GraphState,
  interruptedAsk: IntakeGraphAsk | null,
  extras: Partial<IntakeGraphTurnResult> = {}
): IntakeGraphTurnResult {
  const ask = interruptedAsk;
  const status: IntakeGraphTurnResult['status'] = ask
    ? ask.type === 'panel'
      ? 'panel'
      : 'ask'
    : 'complete';
  // If the node ended because of validation without a fresh interrupt, keep ask.
  const finalAsk =
    ask ?? (state.errorKey && state.lastAsk ? state.lastAsk : null);
  return {
    threadId,
    status: finalAsk
      ? finalAsk.type === 'panel'
        ? 'panel'
        : 'ask'
      : status === 'complete'
      ? 'complete'
      : 'ask',
    ask: finalAsk,
    data: state.data ?? EMPTY_DISCOVERY,
    answered: sanitizeAnswered(state.answered),
    progress: progressFor(state.data ?? EMPTY_DISCOVERY, state.answered ?? []),
    errorKey: state.errorKey ?? null,
    ...extras,
  };
}

function interruptFromResult(result: unknown): {
  ask: IntakeGraphAsk | null;
  errorKey: string | null;
} {
  if (!isInterrupted(result)) return { ask: null, errorKey: null };
  const payload = result as { __interrupt__?: Array<{ value?: unknown }> };
  const value = payload.__interrupt__?.[0]?.value;
  if (!value || typeof value !== 'object') return { ask: null, errorKey: null };
  const record = value as IntakeGraphAsk & { errorKey?: string };
  if (!record.questionId || !record.prompt) {
    return { ask: null, errorKey: null };
  }
  const { errorKey: interruptError, ...ask } = record;
  return {
    ask: ask as IntakeGraphAsk,
    errorKey: interruptError ?? null,
  };
}

export async function startIntakeGraph(
  input: IntakeGraphStartInput = {}
): Promise<IntakeGraphTurnResult> {
  const threadId = randomUUID();
  const locale = localeTag(input.locale);
  const data = mergeDiscovery(input.data);
  const answered = sanitizeAnswered(input.answered);

  // Cheap path: script already spent — no model, no checkpoint work.
  if (!nextQuestion(data, answered)) {
    return {
      threadId,
      status: 'complete',
      ask: null,
      data,
      answered,
      progress: progressFor(data, answered),
    };
  }

  try {
    const result = await compiled.invoke(
      {
        data,
        answered,
        locale,
        status: 'pending',
        lastAsk: null,
        errorKey: null,
        pendingNote: null,
      },
      { configurable: { thread_id: threadId } }
    );

    const { ask, errorKey } = interruptFromResult(result);
    const snap = await compiled.getState({
      configurable: { thread_id: threadId },
    });
    const values = {
      data,
      answered,
      locale,
      status: 'pending' as const,
      lastAsk: ask,
      errorKey,
      ...(snap.values as Partial<GraphState>),
    } as GraphState;

    if (ask) {
      return toResult(threadId, { ...values, lastAsk: ask, errorKey }, ask, {
        errorKey,
        ...(errorKey ? { reason: 'validation' as const } : {}),
      });
    }

    return toResult(threadId, result as GraphState, null);
  } catch (error) {
    console.error(
      '[intake-graph] start failed:',
      error instanceof Error ? error.message : error
    );
    return scriptedFallback({
      threadId,
      data,
      answered,
      locale,
      reason: 'error',
    });
  }
}

export async function resumeIntakeGraph(
  input: IntakeGraphResumeInput
): Promise<IntakeGraphTurnResult> {
  const threadId = input.threadId?.trim();
  if (!threadId) {
    return scriptedFallback({
      threadId: randomUUID(),
      data: mergeDiscovery(input.data),
      answered: sanitizeAnswered(input.answered),
      locale: localeTag(input.locale),
      reason: 'error',
    });
  }

  try {
    const existing = await compiled.getState({
      configurable: { thread_id: threadId },
    });
    if (!existing.values || Object.keys(existing.values).length === 0) {
      return recoverFromClientMirror(input);
    }

    const result = await compiled.invoke(
      new Command({ resume: input.resume }),
      {
        configurable: { thread_id: threadId },
      }
    );

    const { ask, errorKey } = interruptFromResult(result);
    const snap = await compiled.getState({
      configurable: { thread_id: threadId },
    });
    const values = (snap.values ?? result) as GraphState;

    if (ask) {
      return toResult(threadId, { ...values, lastAsk: ask, errorKey }, ask, {
        errorKey,
        ...(errorKey ? { reason: 'validation' as const } : {}),
      });
    }

    const finalState = values as GraphState;
    if (!nextQuestion(finalState.data, finalState.answered)) {
      return toResult(
        threadId,
        { ...finalState, status: 'complete', lastAsk: null },
        null
      );
    }

    return toResult(threadId, finalState, finalState.lastAsk ?? null);
  } catch (error) {
    console.error(
      '[intake-graph] resume failed:',
      error instanceof Error ? error.message : error
    );
    return recoverFromClientMirror(input, 'error');
  }
}

async function recoverFromClientMirror(
  input: IntakeGraphResumeInput,
  reason: IntakeGraphTurnResult['reason'] = 'error'
): Promise<IntakeGraphTurnResult> {
  const data = mergeDiscovery(input.data);
  const answered = sanitizeAnswered(input.answered);
  const locale = localeTag(input.locale);
  const pending = nextQuestion(data, answered);

  if (!pending) {
    return {
      threadId: input.threadId || randomUUID(),
      status: 'complete',
      ask: null,
      data,
      answered,
      progress: progressFor(data, answered),
      skipped: true,
      reason,
    };
  }

  // Apply the resume against the pending question without the checkpoint, then
  // open a fresh thread on whatever remains.
  const applied = applyResumeTurn({
    data,
    answered,
    pendingId: pending.id,
    resume: input.resume,
  });

  if (applied.errorKey) {
    const t = deps.translate(locale);
    return {
      threadId: input.threadId || randomUUID(),
      status: pending.kind === 'panel' ? 'panel' : 'ask',
      ask: scriptedAsk(pending, data, t),
      data,
      answered,
      progress: progressFor(data, answered),
      errorKey: applied.errorKey,
      reason: 'validation',
      skipped: true,
    };
  }

  return startIntakeGraph({
    data: applied.data,
    answered: applied.answered,
    locale,
  }).then((result) => ({ ...result, skipped: true, reason }));
}

function scriptedFallback(input: {
  threadId: string;
  data: DiscoveryData;
  answered: IntakeQuestionId[];
  locale: IntakeGraphLocale;
  reason: IntakeGraphTurnResult['reason'];
}): IntakeGraphTurnResult {
  const pending = nextQuestion(input.data, input.answered);
  if (!pending) {
    return {
      threadId: input.threadId,
      status: 'complete',
      ask: null,
      data: input.data,
      answered: input.answered,
      progress: progressFor(input.data, input.answered),
      skipped: true,
      reason: input.reason,
    };
  }
  const t = deps.translate(input.locale);
  return {
    threadId: input.threadId,
    status: pending.kind === 'panel' ? 'panel' : 'ask',
    ask: scriptedAsk(pending, input.data, t),
    data: input.data,
    answered: input.answered,
    progress: progressFor(input.data, input.answered),
    skipped: true,
    reason: input.reason,
  };
}

/** Exposed for unit tests that want a scripted prompt without invoking LLM. */
export function scriptedPromptFor(
  data: DiscoveryData,
  answered: readonly string[],
  locale: IntakeGraphLocale = 'en'
): string | null {
  const pending = nextQuestion(data, answered);
  if (!pending) return null;
  return promptText(pending, data, deps.translate(locale));
}
