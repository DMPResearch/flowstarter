/**
 * Shared shapes for the LangGraph-powered intake conversation.
 *
 * Rules still live in `intake-script.ts`. The graph only phrases asks,
 * extracts multi-field answers, and pauses for the visitor via interrupt.
 */
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
  reason?: 'budget' | 'unconfigured' | 'error' | 'validation';
  /** Locale key when the primary answer failed validation. */
  errorKey?: string | null;
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
