/**
 * The vocabulary of a sigma classifier, with no taxonomy in it.
 *
 * A "decision" here is one independent head: a named, closed set of labels
 * scored against its own centroids with its own abstention band. The core
 * never learns what those labels mean; a platform package supplies them.
 */

/** Why a head did not produce a confident label. */
export type AbstentionReason =
  | 'confident'
  | 'below_min_sim'
  | 'below_margin'
  | 'encoder_timeout'
  | 'encoder_error'
  | 'artifacts_missing'
  | 'tier_error';

/**
 * One head's centroid verdict on one text.
 *
 * `similarity` and `margin` are cosines in that head's own scoring space.
 * When the centroid file says `centered`, the head's training mean is
 * subtracted before scoring, so these are NOT raw encoder cosines: they are
 * comparable only to the same head's calibrated band.
 */
export interface SemanticResult<L extends string = string> {
  /** Top-scoring label, or null when no vector was produced at all. */
  label: L | null;
  /** Runner-up, because the margin is the interesting half of the band. */
  runnerUp: L | null;
  similarity: number;
  margin: number;
  abstained: boolean;
  reason: AbstentionReason;
}

/** What an injected second tier returns. The caller owns model, key and cost. */
export interface TierVerdict<L extends string = string> {
  label: L;
  /** 0..1. The policy boundary, not the tier, decides what is enough. */
  confidence: number;
  /** Something a human reviewer can read. Never a prompt, never a key. */
  evidence: string;
}

/**
 * A function the CALLER supplies, consulted only after the semantic tier
 * abstains. The core never imports an LLM client, never reads a key and
 * never opens a socket: a second tier is an argument, so a consumer that
 * does not want to spend tokens simply omits it and gets the safe default.
 *
 * Returning null is an abstention and is always allowed.
 */
export type Tier<L extends string = string> = (
  text: string,
  decision: string,
  signal: AbortSignal,
) => Promise<TierVerdict<L> | null>;

/**
 * What happened when an injected tier was consulted.
 *
 * The distinction this type exists to preserve: **an abstention and a failure
 * are not the same fact.** A tier that returned null has read the text and
 * declined to answer, which is an ordinary, cheap, intended outcome. A tier
 * that ran out of budget or threw has answered nothing at all, and the caller
 * is entitled to know that its second tier is broken rather than merely
 * quiet.
 *
 * Before 2026-09-15 the cascade collapsed all five of these onto "the head
 * stayed abstained", and a timed-out paid model call was indistinguishable
 * from a consumer that had passed no tier at all. Staging routed a request to
 * sell drugs and unregistered firearms to `self-serve` three times on exactly
 * that ambiguity: the LLM tier was aborted at its budget, the head fell back,
 * the fallback was recorded as an ordinary `review` with no category, and the
 * funnel's route table reads an uncategorised review as "nothing to act on".
 *
 * - `verdict`    the tier answered and the answer was well formed.
 * - `abstained`  the tier answered `null`. Intended, and not a failure.
 * - `timeout`    the tier did not settle inside `tierBudgetMs`. A FAILURE.
 * - `error`      the tier threw. A FAILURE.
 * - `malformed`  the tier resolved something that is not a `TierVerdict`. A
 *                FAILURE, and a louder one than a timeout: it means the
 *                injected function does not honour its own contract.
 */
export type TierOutcome =
  | 'verdict'
  | 'abstained'
  | 'timeout'
  | 'error'
  | 'malformed';

/** True when this outcome means the tier could not answer, as opposed to would not. */
export function tierFailed(outcome: TierOutcome | null): boolean {
  return outcome === 'timeout' || outcome === 'error' || outcome === 'malformed';
}

export type DecidingTier = 'semantic' | 'injected' | 'default';

/** One head's slice of the trace. */
export interface HeadTrace<L extends string = string> {
  decision: string;
  tier: DecidingTier;
  label: L | null;
  /**
   * The semantic tier reports its margin as confidence; an injected tier
   * reports its own. 0 when nothing decided.
   */
  confidence: number;
  semantic: SemanticResult<L>;
  semanticAbstained: boolean;
  injectedAttempted: boolean;
  /**
   * True when the injected tier was consulted and produced no label, for ANY
   * reason. Kept for compatibility; it cannot tell a decline from a failure,
   * which is what {@link injectedOutcome} is for. Read that instead.
   */
  injectedAbstained: boolean;
  /**
   * Precisely what the injected tier did, or `null` when it was never asked.
   *
   * This is the field a caller must read before treating a fallback as a
   * decision: `tierFailed(head.injectedOutcome)` is the difference between
   * "the second tier had nothing to add" and "the second tier is down".
   */
  injectedOutcome: TierOutcome | null;
  evidence: string | null;
  timings: { semanticMs: number; injectedMs: number };
}

/**
 * Everything the cascade did, for one text, for every head asked for.
 *
 * Every head is scored from ONE embedding: the encoder is the expensive
 * part, the centroid dot products are free.
 */
export interface DecisionTrace {
  heads: Record<string, HeadTrace>;
  /** Wall clock for the whole cascade, embedding included. */
  totalMs: number;
  /** Wall clock of the single shared embedding call. */
  embedMs: number;
  /** Whether that embedding came out of the content-hash cache. */
  embedCacheHit: boolean;
  /** Non-fatal failures, already failed open. Strings only, never the text. */
  errors: string[];
  encoder: { model: string; revision: string };
  centroidsVersion: string;
  configVersion: string;
}

/** Read one head out of a trace with its label type restored. */
export function headOf<L extends string>(
  trace: DecisionTrace,
  decision: string,
): HeadTrace<L> {
  const head = trace.heads[decision];
  if (!head) {
    throw new Error(
      `no head "${decision}" in this trace; it has: ${Object.keys(trace.heads).join(', ') || '(none)'}`,
    );
  }
  return head as HeadTrace<L>;
}
