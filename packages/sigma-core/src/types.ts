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
  injectedAbstained: boolean;
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
