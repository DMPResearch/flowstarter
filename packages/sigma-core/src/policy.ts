/**
 * The deterministic boundary after the probabilistic tiers.
 *
 * The cascade suggests a label. It does not choose an action. This module is
 * where a suggestion becomes something the product does, and it is rules all
 * the way down: a label maps to an action through a mapping the platform
 * declares, and an action that costs somebody something has to clear a guard
 * expressed in numbers from a config file.
 *
 * Two properties worth stating plainly, because they are the reason this is a
 * separate module and not three lines inside the cascade:
 *
 *   - **An abstention is never an action.** It is the fallback, and the
 *     fallback is whatever the platform says the safe thing is. The core has
 *     no idea which of your actions is safe, so it will not guess.
 *   - **Fail closed.** Anything thrown in here — a malformed trace, a missing
 *     head, a mapping that returns nonsense — becomes the fallback in
 *     production. Outside production it rethrows, so a broken artifact fails
 *     a test instead of quietly degrading every request.
 */

import type { DecisionTrace, HeadTrace, SemanticResult } from './types.js';

/** Extra confidence required before an action that costs somebody something. */
export interface ActionGuard {
  /** Minimum centroid similarity, when the semantic tier decided. */
  minSimilarity?: number;
  /** Minimum centroid margin, when the semantic tier decided. */
  minMargin?: number;
  /** Minimum confidence, when an injected tier decided. */
  minTierConfidence?: number;
  /** When true, an injected tier may not produce this action at all. */
  semanticOnly?: boolean;
}

export interface DecisionThresholds<A extends string = string> {
  /** Guards by action. An action with no guard needs only a confident head. */
  guards: Partial<Record<A, ActionGuard>>;
  /**
   * In production, throw -> fallback. Elsewhere, throw -> throw, so a broken
   * centroid file fails the suite rather than turning every request human.
   */
  failClosedInProduction: boolean;
}

export interface DecisionMapping<L extends string = string, A extends string = string> {
  /** Which head in the trace this mapping reads. */
  decision: string;
  /** label -> action. Returning null means "treat as abstained". */
  action: (label: L) => A | null;
  /** Action when the head abstained, errored, or failed a guard. */
  fallback: A;
}

export type OutcomeReason =
  | 'confident'
  | 'abstained'
  | 'guard_not_met'
  | 'unmapped_label'
  | 'error';

export interface PolicyOutcome<L extends string = string, A extends string = string> {
  action: A;
  /** The label that produced the action, or null when the fallback did. */
  label: L | null;
  reason: OutcomeReason;
  /** Machine-readable why, safe to log: never contains the user's text. */
  detail: string;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Map one head of a trace to one action.
 *
 * `thresholds` carries the numbers, `mapping` carries the meaning; neither
 * is hard-coded here, which is what makes this usable by a platform whose
 * taxonomy the core has never heard of.
 */
export function decide<L extends string = string, A extends string = string>(
  trace: DecisionTrace,
  thresholds: DecisionThresholds<A>,
  mapping: DecisionMapping<L, A>,
): PolicyOutcome<L, A> {
  try {
    const head = trace.heads[mapping.decision] as HeadTrace<L> | undefined;
    if (!head) {
      throw new Error(`trace has no head "${mapping.decision}"`);
    }
    if (head.label === null) {
      return {
        action: mapping.fallback,
        label: null,
        reason: 'abstained',
        detail: `${mapping.decision}:${head.semantic.reason}`,
      };
    }
    const action = mapping.action(head.label);
    if (action === null) {
      return {
        action: mapping.fallback,
        label: head.label,
        reason: 'unmapped_label',
        detail: `${mapping.decision}:${head.label}`,
      };
    }
    const guard = thresholds.guards[action];
    const failure = guard ? guardFailure(head, guard) : null;
    if (failure) {
      return {
        action: mapping.fallback,
        label: head.label,
        reason: 'guard_not_met',
        detail: `${mapping.decision}:${head.label}:${failure}`,
      };
    }
    return {
      action,
      label: head.label,
      reason: 'confident',
      detail: `${mapping.decision}:${head.label}:${head.tier}`,
    };
  } catch (error) {
    if (!thresholds.failClosedInProduction || !isProduction()) throw error;
    return {
      action: mapping.fallback,
      label: null,
      reason: 'error',
      detail: `${mapping.decision}:${error instanceof Error ? error.name : 'error'}`,
    };
  }
}

/**
 * Would this semantic verdict, ON ITS OWN, settle the decision?
 *
 * The abstention band and the action guards are two different bars, and until
 * 2026-09-15 only the first of them could reach the cascade. A head that
 * cleared its band and then failed the guard for the action its label maps to
 * produced the platform's fallback — and produced it AFTER the cascade had
 * finished, so the injected tier was never asked, even though "this answer is
 * not strong enough to act on" is precisely the case the injected tier exists
 * for. Staging read `review, tier=embedding, confidence 0.049` on
 * "I need a website for my business." and recorded it as a decision; it was
 * a `clean` that missed the allow guard's similarity floor by a mile.
 *
 * So the guards are exported as a question the cascade can ask BEFORE it
 * decides whether to spend a second tier. Pure, and the same code path
 * `decide` takes, so the two can never disagree.
 */
export function semanticSettles<L extends string = string, A extends string = string>(
  semantic: SemanticResult<L>,
  thresholds: DecisionThresholds<A>,
  mapping: DecisionMapping<L, A>,
): boolean {
  if (semantic.abstained || semantic.label === null) return false;
  const action = mapping.action(semantic.label);
  if (action === null) return false;
  const guard = thresholds.guards[action];
  if (!guard) return true;
  return guardOf('semantic', semantic, semantic.margin, guard) === null;
}

function guardFailure(head: HeadTrace, guard: ActionGuard): string | null {
  return guardOf(head.tier, head.semantic, head.confidence, guard);
}

function guardOf(
  tier: HeadTrace['tier'],
  semantic: SemanticResult,
  confidence: number,
  guard: ActionGuard,
): string | null {
  if (tier === 'semantic') {
    if (guard.minSimilarity !== undefined && semantic.similarity < guard.minSimilarity) {
      return 'min_similarity';
    }
    if (guard.minMargin !== undefined && semantic.margin < guard.minMargin) {
      return 'min_margin';
    }
    return null;
  }
  if (tier === 'injected') {
    if (guard.semanticOnly) return 'semantic_only';
    if (guard.minTierConfidence !== undefined && confidence < guard.minTierConfidence) {
      return 'min_tier_confidence';
    }
    return null;
  }
  return 'no_tier_decided';
}
