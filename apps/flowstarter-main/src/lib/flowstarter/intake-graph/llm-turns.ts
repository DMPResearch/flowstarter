import 'server-only';

/**
 * Model calls for the intake graph: phrase an ask, extract fields from a
 * turn, answer a question the visitor asked back, and rephrase a validation
 * failure naturally.
 *
 * All four go through `callLlmObject` under the `intake_graph` budget.
 * Callers must fail open — scripted `promptText`, single-field apply, and the
 * raw locale error string are always enough to keep the funnel moving with
 * no model in the loop at all.
 */
import { z } from 'zod';
import { callLlmObject } from '@/lib/ai/llm';
import {
  TIER_MONTHLY_FROM,
  TIER_SETUP_FROM,
  type DiscoveryData,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import type { IntakeQuestion } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';
import { knownSnapshot, openQuestionsForModel } from './script-bridge';
import type { IntakeGraphLocale } from './types';

const PhraseSchema = z.object({
  prompt: z.string().min(1).max(500),
});

const ExtractSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        value: z.string().min(1).max(2000),
      })
    )
    .max(8),
});

const AnswerQuestionSchema = z.object({
  answer: z.string().min(1).max(400),
});

const ClarifySchema = z.object({
  clarification: z.string().min(1).max(300),
});

export type PhraseAskInput = {
  question: IntakeQuestion;
  scriptedPrompt: string;
  data: DiscoveryData;
  answered: readonly string[];
  locale: IntakeGraphLocale;
  t: (key: string) => string;
  /**
   * What the visitor just said, and which question it answered — so the
   * agent can react in one short sentence before asking the next thing,
   * instead of moving straight from one field to the next like a form.
   * Absent for the very first question of the conversation.
   */
  lastAnswer?: { questionId: string; text: string } | null;
};

export async function phraseAsk(input: PhraseAskInput): Promise<string> {
  const open = openQuestionsForModel(input.data, input.answered, input.t);
  const { object } = await callLlmObject<{ prompt: string }>({
    action: 'intake_graph',
    workspaceId: null,
    schema: PhraseSchema,
    temperature: 0.4,
    system:
      'Respond with ONLY a JSON object of the shape {"prompt": string} — ' +
      'no prose outside that object, no markdown fences. ' +
      "You are Flowstarter's intake agent, talking with a prospective " +
      'client about the business site they want built. If `lastAnswer` is ' +
      'given, react to it in one short, specific sentence — the way a ' +
      'person who was actually listening would, not a generic "great!" — ' +
      'then ask the next scripted question in the same short message. If ' +
      '`lastAnswer` is absent this is the opening question: ask it warmly, ' +
      'with no reaction to invent. Keep the scripted question’s meaning ' +
      'exactly. Do not ask about anything else, and do not invent ' +
      'requirements the business has not mentioned. Two to three short ' +
      'sentences at most. Match the locale.',
    prompt: JSON.stringify({
      locale: input.locale,
      pendingId: input.question.id,
      kind: input.question.kind,
      scriptedPrompt: input.scriptedPrompt,
      known: knownSnapshot(input.data),
      lastAnswer: input.lastAnswer ?? null,
      alsoOpenSoon: open.filter((q) => q.id !== input.question.id).slice(0, 3),
    }),
  });
  const prompt = object.prompt?.trim();
  return prompt || input.scriptedPrompt;
}

export type ExtractAnswersInput = {
  pendingId: string;
  userText: string;
  data: DiscoveryData;
  answered: readonly string[];
  locale: IntakeGraphLocale;
  t: (key: string) => string;
};

export async function extractAnswers(
  input: ExtractAnswersInput
): Promise<Array<{ id: string; value: string }>> {
  const open = openQuestionsForModel(input.data, input.answered, input.t);
  if (!input.userText.trim() || open.length === 0) return [];

  const { object } = await callLlmObject<{
    answers: Array<{ id: string; value: string }>;
  }>({
    action: 'intake_graph',
    workspaceId: null,
    schema: ExtractSchema,
    temperature: 0,
    system:
      'Respond with ONLY a JSON object of the shape {"answers": ' +
      '[{"id": string, "value": string}]} — no prose outside that object, ' +
      'no markdown fences. An empty `answers` array is a valid response ' +
      'when nothing was clearly answered. ' +
      'Extract intake fields the visitor already answered in this one message. ' +
      "Only use ids from the allowed list. Prefer the visitor's own words. " +
      'For choice fields, return the option value (not the label) when it matches. ' +
      'Omit fields that were not clearly answered. Never invent facts.',
    prompt: JSON.stringify({
      locale: input.locale,
      pendingId: input.pendingId,
      userText: input.userText,
      known: knownSnapshot(input.data),
      allowed: open,
    }),
  });

  return (object.answers ?? []).filter(
    (entry) =>
      typeof entry.id === 'string' &&
      typeof entry.value === 'string' &&
      entry.value.trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Ground truth for a question the visitor asks back
// ---------------------------------------------------------------------------

/**
 * The facts `answerVisitorQuestion` is allowed to quote — nothing else. Every
 * number here is code, not a model's guess: the 20/80 deposit split is the
 * same one `packages/agentic-codegen`'s state machine charges, and the tier
 * prices are the same table the recommendation panel renders from. Policy
 * prose is pulled from the locale catalogue rather than duplicated as a new
 * hard-coded string, so there is exactly one place either can drift.
 */
function flowstarterFacts(t: (key: string) => string) {
  return {
    buildDepositPercent: 20,
    buildBalancePercent: 80,
    setupFeeFrom: TIER_SETUP_FROM,
    monthlyFrom: TIER_MONTHLY_FROM,
    setupFeePolicy: t('terms.s3.i1.text'),
    subscriptionPolicy: t('terms.s3.i2.text'),
    previewDepositPolicy: t('landing.discovery.recommendation.deposit.body'),
    pricingFootnote: t('landing.discovery.recommendation.footnote'),
  };
}

export type AnswerVisitorQuestionInput = {
  /** The visitor's message, containing a question. */
  questionText: string;
  /** The question the graph is waiting on — so the reply can stay on topic. */
  pending: IntakeQuestion;
  data: DiscoveryData;
  locale: IntakeGraphLocale;
  t: (key: string) => string;
};

/**
 * A short, grounded reply to a question the visitor asked instead of
 * answering — "why do you need that?", "what does the deposit include?".
 * Only called when the visitor's turn contains a `?` (a deterministic gate,
 * not a model's judgement call), and only ever allowed to speak from
 * `flowstarterFacts`: it is told to decline rather than invent an answer it
 * was not given the facts for.
 */
export async function answerVisitorQuestion(
  input: AnswerVisitorQuestionInput
): Promise<string> {
  const { object } = await callLlmObject<{ answer: string }>({
    action: 'intake_graph',
    workspaceId: null,
    schema: AnswerQuestionSchema,
    temperature: 0.2,
    system:
      'Respond with ONLY a JSON object of the shape {"answer": string} — ' +
      'no prose outside that object, no markdown fences. ' +
      "You are Flowstarter's intake agent. The visitor asked a question in " +
      'the middle of the intake instead of answering directly. The `answer` ' +
      'field is one or two short, warm sentences, using ONLY the facts ' +
      'given in `facts` — never invent a number, a policy, or a feature ' +
      'that is not there. If the question is not about Flowstarter’s ' +
      'process, pricing, or the deposit, or the facts given do not cover ' +
      'it, the `answer` says briefly that you are not sure and that the ' +
      'team can cover it on the discovery call. Do not answer the pending ' +
      'question for them and do not ask a new one — that happens ' +
      'separately. Match the locale.',
    prompt: JSON.stringify({
      locale: input.locale,
      visitorMessage: input.questionText.slice(0, 1_000),
      pendingId: input.pending.id,
      known: knownSnapshot(input.data),
      facts: flowstarterFacts(input.t),
    }),
  });
  const answer = object.answer?.trim();
  if (!answer) throw new Error('answerVisitorQuestion returned nothing usable');
  return answer;
}

export type PhraseClarificationInput = {
  pending: IntakeQuestion;
  /** The scripted correction, e.g. `t(errorKey)` — the ground truth for what is wrong. */
  scriptedError: string;
  /** What the visitor actually typed, for context only. */
  rawText: string;
  locale: IntakeGraphLocale;
  t: (key: string) => string;
};

/**
 * Rephrases a failed validation naturally instead of showing the raw locale
 * error string twice in a row. The *reason* the answer failed is still the
 * script's (`scriptedError`, ground truth); the model only chooses warmer
 * words to say the same thing and invite another try.
 */
export async function phraseClarification(
  input: PhraseClarificationInput
): Promise<string> {
  const { object } = await callLlmObject<{ clarification: string }>({
    action: 'intake_graph',
    workspaceId: null,
    schema: ClarifySchema,
    temperature: 0.2,
    system:
      'Respond with ONLY a JSON object of the shape {"clarification": ' +
      'string} — no prose outside that object, no markdown fences. ' +
      "One visitor answer did not pass the script's own validation. The " +
      '`clarification` field rephrases `scriptedError` as one short, warm ' +
      'sentence that explains what is needed for this specific question ' +
      'and invites another try. Do not repeat the scripted error word for ' +
      'word, do not scold, and do not soften the requirement — the field ' +
      'is still required if the script says so. Match the locale.',
    prompt: JSON.stringify({
      locale: input.locale,
      pendingId: input.pending.id,
      kind: input.pending.kind,
      scriptedError: input.scriptedError,
      visitorText: input.rawText.slice(0, 500),
    }),
  });
  const clarification = object.clarification?.trim();
  if (!clarification) {
    throw new Error('phraseClarification returned nothing usable');
  }
  return clarification;
}
