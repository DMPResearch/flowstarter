/**
 * Deterministic bridge between the LangGraph intake and `intake-script.ts`.
 *
 * The script still owns order, validation, apply, and "done". This module only
 * packages questions for the model and folds answers back into DiscoveryData.
 */
import {
  type DiscoveryData,
  EMPTY_DISCOVERY,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import {
  type IntakeQuestion,
  type IntakeQuestionId,
  conversationProgress,
  nextQuestion,
  optionLabel,
  promptText,
  questionById,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';
import type {
  IntakeGraphAsk,
  IntakeGraphLocale,
  IntakeGraphResume,
} from './types';

type Translate = (key: string) => string;

export function mergeDiscovery(
  partial?: Partial<DiscoveryData> | null
): DiscoveryData {
  return { ...EMPTY_DISCOVERY, ...(partial ?? {}) };
}

export function sanitizeAnswered(
  answered: readonly string[] | undefined
): IntakeQuestionId[] {
  if (!answered?.length) return [];
  const out: IntakeQuestionId[] = [];
  for (const id of answered) {
    if (!questionById(id)) continue;
    if (!out.includes(id as IntakeQuestionId)) {
      out.push(id as IntakeQuestionId);
    }
  }
  return out;
}

export function scriptedAsk(
  question: IntakeQuestion,
  data: DiscoveryData,
  t: Translate
): IntakeGraphAsk {
  return {
    type: question.kind === 'panel' ? 'panel' : 'ask',
    questionId: question.id,
    kind: question.kind,
    prompt: promptText(question, data, t),
    placeholder: question.placeholderKey
      ? t(question.placeholderKey)
      : undefined,
    required: question.required,
    options: question.options?.map((option) => ({
      value: option.value,
      label: optionLabel(option, t),
    })),
  };
}

/** Compact catalogue the model may fill from one visitor turn. */
export function openQuestionsForModel(
  data: DiscoveryData,
  answered: readonly string[],
  essentialsOnly: boolean,
  t: Translate
): Array<{
  id: IntakeQuestionId;
  kind: string;
  required: boolean;
  prompt: string;
  options?: Array<{ value: string; label: string }>;
}> {
  const open: IntakeQuestionId[] = [];
  let cursor = [...answered];
  // Walk a few steps ahead without mutating real state: show the model what
  // it is allowed to fill from one generous answer.
  for (let i = 0; i < 6; i += 1) {
    const next = nextQuestion(data, cursor, essentialsOnly);
    if (!next || next.kind === 'panel') break;
    open.push(next.id);
    cursor = [...cursor, next.id];
  }
  return open.map((id) => {
    const question = questionById(id)!;
    return {
      id: question.id,
      kind: question.kind,
      required: question.required,
      prompt: promptText(question, data, t),
      options: question.options?.map((option) => ({
        value: option.value,
        label: optionLabel(option, t),
      })),
    };
  });
}

export function knownSnapshot(data: DiscoveryData): Record<string, string> {
  return {
    fullName: data.fullName,
    email: data.email,
    businessName: data.businessName,
    industry: data.industry,
    description: data.description,
    targetAudience: data.targetAudience,
    goal: data.goal,
    brandTone: data.brandTone,
    pageCount: data.pageCount,
    timeline: data.timeline,
    commerceMode: data.commerceMode,
    catalogSize: data.catalogSize,
    calComUrl: data.calComUrl,
    customIntegrations: data.customIntegrations,
    selectedTier: data.selectedTier,
    subscription: data.subscription,
  };
}

export interface AppliedTurn {
  data: DiscoveryData;
  answered: IntakeQuestionId[];
  errorKey: string | null;
  /** Raws that were accepted, for provenance / parent sync. */
  applied: Array<{ id: IntakeQuestionId; raw: string }>;
}

/**
 * Fold a resume value into DiscoveryData using the script's validators/appliers.
 * Multi-field extractions are applied in order; the pending question is required
 * to land unless the visitor skipped an optional one.
 */
export function applyResumeTurn(input: {
  data: DiscoveryData;
  answered: readonly string[];
  pendingId: IntakeQuestionId;
  resume: IntakeGraphResume;
  /** Extra fields the model pulled from the same utterance. */
  extracted?: Array<{ id: string; value: string }>;
}): AppliedTurn {
  const pending = questionById(input.pendingId);
  if (!pending) {
    return {
      data: input.data,
      answered: sanitizeAnswered(input.answered),
      errorKey: 'landing.discovery.chat.errors.required',
      applied: [],
    };
  }

  // A missing resume is a turn that said nothing, so it fails the same way an
  // empty answer does. The type says this cannot happen and the route parses
  // the body with zod first, but `resumeIntakeGraph` reaches here through
  // `recoverFromClientMirror`, which runs from a catch block and outside any
  // try of its own: dereferencing `input.resume.kind` on null threw past
  // every handler instead of failing open, which is the one thing this
  // recovery path exists not to do.
  if (input.resume === null || input.resume === undefined) {
    return {
      data: input.data,
      answered: sanitizeAnswered(input.answered),
      errorKey: 'landing.discovery.chat.errors.required',
      applied: [],
    };
  }

  let data = input.data;
  const answered = sanitizeAnswered(input.answered);
  const applied: AppliedTurn['applied'] = [];

  if (input.resume.kind === 'skip') {
    if (pending.required) {
      return {
        data,
        answered,
        errorKey: 'landing.discovery.chat.errors.required',
        applied: [],
      };
    }
    if (!answered.includes(pending.id)) answered.push(pending.id);
    applied.push({ id: pending.id, raw: '' });
    return { data, answered, errorKey: null, applied };
  }

  const primaryFromExtract = (input.extracted ?? []).find(
    (entry) => entry.id === pending.id && entry.value.trim()
  );
  const primaryRaw = (
    primaryFromExtract?.value ??
    (input.resume.kind === 'panel'
      ? input.resume.value
      : input.resume.kind === 'text'
      ? input.resume.text
      : '')
  ).trim();

  if (pending.required && !primaryRaw) {
    return {
      data,
      answered,
      errorKey: 'landing.discovery.chat.errors.required',
      applied: [],
    };
  }

  if (primaryRaw) {
    const failed = pending.validate?.(primaryRaw) ?? null;
    if (failed) {
      // If the utterance as a whole failed but an extract for this field
      // exists we already preferred it above. A failed primary stops the turn.
      return { data, answered, errorKey: failed, applied: [] };
    }
    data = pending.apply(data, primaryRaw);
  }
  if (!answered.includes(pending.id)) answered.push(pending.id);
  applied.push({ id: pending.id, raw: primaryRaw });

  // Bonus fields from a multi-answer utterance. Never override the primary
  // question, and never invent ids the script does not know.
  for (const entry of input.extracted ?? []) {
    const id = entry.id as IntakeQuestionId;
    if (id === pending.id) continue;
    if (answered.includes(id)) continue;
    const question = questionById(id);
    if (!question || question.kind === 'panel') continue;
    const raw = entry.value.trim();
    if (!raw) continue;
    const failed = question.validate?.(raw) ?? null;
    if (failed) continue;
    data = question.apply(data, raw);
    answered.push(id);
    applied.push({ id, raw });
  }

  return { data, answered, errorKey: null, applied };
}

export function progressFor(
  data: DiscoveryData,
  answered: readonly string[],
  essentialsOnly: boolean
) {
  return conversationProgress(data, answered, essentialsOnly);
}

export function localeTag(
  locale: IntakeGraphLocale | undefined
): IntakeGraphLocale {
  return locale === 'ro' ? 'ro' : 'en';
}
