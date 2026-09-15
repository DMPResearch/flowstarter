/**
 * Shared shapes for the LangGraph-powered intake conversation.
 *
 * Rules still live in `intake-script.ts`. The graph only phrases asks,
 * extracts multi-field answers, and pauses for the visitor via interrupt.
 */
import type { PolicyNotice } from '@/lib/policy/copy';
import type { DiscoveryData } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import type {
  IntakeOption,
  IntakeQuestionId,
  IntakeQuestionKind,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/intake-script';

export type IntakeGraphLocale = 'en' | 'ro';

export type IntakeGraphStatus = 'ask' | 'panel' | 'complete';

/** What the graph shows the visitor when it pauses. */
export interface IntakeGraphAsk {
  type: 'ask' | 'panel';
  questionId: IntakeQuestionId;
  kind: IntakeQuestionKind;
  /** Agent line — LLM-phrased when possible, scripted otherwise. */
  prompt: string;
  placeholder?: string;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  /**
   * An extra reactive line shown once, ahead of `prompt`: a short grounded
   * answer to a question the visitor asked back, or a natural nudge in place
   * of a raw validation message. Absent on an ordinary turn.
   */
  note?: string;
}

/** Visitor reply when the graph resumes. */
export type IntakeGraphResume =
  | { kind: 'text'; text: string }
  | { kind: 'skip' }
  | { kind: 'panel'; value: string };

export interface IntakeGraphProgress {
  done: number;
  total: number;
}

export interface IntakeGraphTurnResult {
  threadId: string;
  status: IntakeGraphStatus;
  ask: IntakeGraphAsk | null;
  data: DiscoveryData;
  answered: IntakeQuestionId[];
  progress: IntakeGraphProgress;
  /** True when we bowed out of the model path but still have a scripted ask. */
  skipped?: boolean;
  reason?: 'budget' | 'unconfigured' | 'error' | 'validation' | 'policy';
  /** Locale key when the primary answer failed validation. */
  errorKey?: string | null;
  /**
   * The acceptable-use gate stopped the intake, and which way.
   *
   * The scope gate's own two words (`@/lib/flowstarter/scope-route`'s
   * `ScopeRoute`), so the browser renders one policy screen for both surfaces
   * instead of learning a second vocabulary for the same two verdicts.
   * Absent on every ordinary turn.
   */
  policyStop?: 'refused' | 'hold';
  /**
   * What to say, written by `@/lib/policy/copy` in the visitor's own
   * language and carried here rather than re-derived in the browser.
   *
   * This field is the fix for the defect the showcase recorder filmed on
   * 2026-09-15: the intake's old moderator ended a prohibited turn with
   * `status: 'complete'`, `ask: null` and a blanked description, and said
   * nothing at all. A visitor's answer is never discarded silently now --
   * either the conversation continues, or this says why it did not.
   */
  policy?: PolicyNotice | null;
}

export interface IntakeGraphStartInput {
  data?: DiscoveryData;
  answered?: readonly string[];
  locale?: IntakeGraphLocale;
}

export interface IntakeGraphResumeInput {
  threadId: string;
  resume: IntakeGraphResume;
  /** Client mirror — used if the in-memory checkpoint is gone. */
  data?: DiscoveryData;
  answered?: readonly string[];
  locale?: IntakeGraphLocale;
}

export type {
  DiscoveryData,
  IntakeOption,
  IntakeQuestionId,
  IntakeQuestionKind,
};
